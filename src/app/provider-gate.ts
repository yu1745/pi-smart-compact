import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type Handler = (...args: any[]) => any;
type Registration = { handler: Handler };
const allowed = (ctx: ExtensionContext) => Boolean(ctx?.model?.provider && ctx.model.provider !== "openai-codex");

/** Defer all original registration until the host supplies the actual session model.
 * Once shut down, the original runtime cannot safely be restarted: require /reload.
 */
export function withProviderGate(pi: ExtensionAPI, initialize: (api: ExtensionAPI) => void): void {
 let initialized = false;
 let enabled = false;
 let retired = false;
 const starts = new Set<Registration>();
 const shutdowns = new Set<Registration>();
 const tools = new Map<string, any>();
 const lifetime = new AbortController();
 const runnable = (ctx: ExtensionContext) => enabled && allowed(ctx);
 const guardedContext = (ctx: ExtensionContext) => new Proxy(ctx, {
  get(target, key) {
   if (key === "signal") return target.signal ? AbortSignal.any([target.signal, lifetime.signal]) : lifetime.signal;
   const value = Reflect.get(target, key);
   if (typeof value !== "function") return value;
   if (["compact", "shutdown", "executeTool", "newSession", "switchSession", "fork", "navigateTree"].includes(String(key))) {
    return (...args: any[]) => runnable(target) ? value.apply(target, args) : undefined;
   }
   return value.bind(target);
  },
 });
 const proxy = new Proxy(pi, {
  get(target, key) {
   if (key === "on") return (event: string, handler: Handler) => {
    if (!enabled) return () => {};
    if (event === "session_start" || event === "session_shutdown") {
     const handlers = event === "session_start" ? starts : shutdowns;
     const registration = { handler };
     handlers.add(registration);
     return () => { handlers.delete(registration); };
    }
    return (target.on as Handler)(event, async (event: any, ctx: ExtensionContext) => {
     if (!runnable(ctx)) return;
     const result = await handler(event, guardedContext(ctx));
     return runnable(ctx) ? result : undefined;
    });
   };
   if (key === "registerTool") return (definition: any) => {
    if (!enabled) return;
    const guarded = { ...definition, execute: (...args: any[]) => {
     if (!runnable(args[4])) throw new Error("Smart Compact is disabled for this provider; /reload is required after switching back.");
     args[2] = args[2] ? AbortSignal.any([args[2], lifetime.signal]) : lifetime.signal;
     args[4] = guardedContext(args[4]);
     return definition.execute(...args);
    } };
    for (const key of Object.keys(definition)) {
     if (key !== "execute" && typeof definition[key] === "function") {
      guarded[key] = (...args: any[]) => enabled ? definition[key](...args) : undefined;
     }
    }
    tools.set(definition.name, guarded);
    target.registerTool(guarded);
   };
   if (key === "registerCommand" || key === "registerShortcut") return (name: string, definition: any) => {
    if (!enabled) return;
    const guarded = { ...definition };
    for (const key of Object.keys(definition)) {
     if (typeof definition[key] === "function") guarded[key] = (...args: any[]) => enabled ? definition[key](...args) : undefined;
    }
    (target[key] as Handler)(name, { ...guarded, handler: (...args: any[]) => {
     const ctx = args.at(-1) as ExtensionContext;
     if (runnable(ctx)) {
      args[args.length - 1] = guardedContext(ctx);
      return definition.handler(...args);
     }
    } });
   };
   const value = Reflect.get(target, key);
   if (typeof value !== "function") return value;
   if (/^(register|set|send|append)/.test(String(key)) || key === "exec") {
    return (...args: any[]) => enabled ? value.apply(target, args) : undefined;
   }
   return value.bind(target);
  },
 });
 async function dispatchLifecycle(handlers: Set<Registration>, event: unknown, ctx: ExtensionContext, guard = false) {
  const failures: unknown[] = [];
  for (const { handler } of [...handlers]) {
   if (guard && !runnable(ctx)) break;
   try { await handler(event, guard ? guardedContext(ctx) : ctx); }
   catch (error) { failures.push(error); }
  }
  // Like the host runner, one failed handler must not skip later cleanup.
  if (failures.length) throw new AggregateError(failures, "Smart Compact lifecycle handler failed");
 }
 async function disable(ctx: ExtensionContext) {
  enabled = false;
  if (!initialized || retired) return;
  retired = true;
  lifetime.abort();
  // Withdraw first, even if a cleanup handler fails. Pi has no unregisterTool.
  // Conversely, a host registration failure must not skip background cleanup.
  const failures: unknown[] = [];
  for (const tool of tools.values()) {
   try { pi.registerTool({ ...tool, exposure: "hidden" }); }
   catch (error) { failures.push(error); }
  }
  try {
   if (tools.size) pi.setActiveTools(pi.getActiveTools().filter(name => !tools.has(name)));
  } catch (error) { failures.push(error); }
  try {
   await dispatchLifecycle(shutdowns, { type: "session_shutdown", reason: "reload" }, ctx);
  } catch (error) { failures.push(error); }
  ctx.ui.notify("Smart Compact disabled. Switch to a non-Codex provider and /reload to enable it again; /reload on Codex removes prior registrations.", "info");
  if (failures.length) throw new AggregateError(failures, "Smart Compact disable/cleanup failed; /reload required");
 }
 pi.on("session_start", async (event, ctx) => {
  if (!allowed(ctx)) { await disable(ctx); return; }
  if (retired) return;
  enabled = true;
  if (!initialized) {
   initialized = true;
   try { initialize(proxy); }
   catch (error) { await disable(ctx); throw error; }
  }
  // Runner snapshots registrations before dispatch. We own session_start
  // dispatch entirely, so neither snapshot nor live-array runners double-call.
  await dispatchLifecycle(starts, event, ctx, true);
 });
 pi.on("model_select", async (_event, ctx) => {
  if (!allowed(ctx)) await disable(ctx);
  // No synthetic session_start on model_select: a previously disabled cold
  // start needs /reload too, rather than partially restoring session state.
  else if (!enabled) ctx.ui.notify("Smart Compact requires /reload to enable after a provider change.", "info");
 });
 pi.on("session_shutdown", async (event, ctx) => {
  if (!enabled) return;
  enabled = false;
  retired = true;
  lifetime.abort();
  await dispatchLifecycle(shutdowns, event, ctx);
 });
}
