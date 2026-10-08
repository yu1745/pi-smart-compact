import { describe, expect, it } from "bun:test";
import { withProviderGate } from "../src/app/provider-gate.ts";
import smartCompact from "../src/index.ts";
import rtk from "../src/rtk.ts";

function harness(factory: (api: any) => void, liveDispatch = false) {
 const handlers = new Map<string, any[]>();
 const tools = new Map<string, any>();
 const commands = new Map<string, any>();
 const shortcuts = new Map<string, any>();
 let active = ["read"];
 const notices: string[] = [];
 let executions = 0;
 const api: any = {
  on(name: string, handler: any) {
   const list = handlers.get(name) ?? [];
   list.push(handler); handlers.set(name, list);
   return () => { const index = list.indexOf(handler); if (index >= 0) list.splice(index, 1); };
  },
  registerTool(tool: any) { tools.set(tool.name, tool); if (!tool.exposure || tool.exposure === "direct") active.push(tool.name); },
  registerCommand(name: string, command: any) { commands.set(name, command); },
  registerShortcut(name: string, shortcut: any) { shortcuts.set(name, shortcut); },
  getActiveTools: () => active,
  setActiveTools: (names: string[]) => { active = names; },
  exec: () => { executions++; return Promise.resolve({ stdout: "rtk 0.50.0", code: 0 }); },
 };
 factory(api);
 const context = (provider?: string): any => ({ model: provider ? { provider, id: "gpt-5" } : undefined, ui: { notify: (text: string) => notices.push(text) } });
 async function emit(name: string, ctx: any, event: any = {}) {
  const list = handlers.get(name) ?? [];
  const results = [];
  for (const handler of liveDispatch ? list : [...list]) results.push(await handler({ type: name, ...event }, ctx));
  return results;
 }
 return { api, tools, commands, shortcuts, context, emit, handlers, notices, active: () => active, executions: () => executions };
}

describe("provider gate", () => {
 for (const factory of [smartCompact, rtk]) {
  it.each([undefined, "openai-codex"])(`${factory.name}: cold start %s registers no tools or commands and does not intercept hooks`, async provider => {
   const h = harness(factory);
   expect(h.tools.size).toBe(0); expect(h.commands.size).toBe(0);
   expect([...h.handlers.keys()]).toEqual(["session_start", "model_select", "session_shutdown"]);
   const ctx = h.context(provider);
   await h.emit("session_start", ctx);
   for (const name of ["session_before_compact", "context", "before_provider_request", "before_agent_start", "agent_settled", "tool_call"]) {
    expect(await h.emit(name, ctx)).toEqual([]);
   }
   expect(h.tools.size).toBe(0); expect(h.commands.size).toBe(0); expect(h.executions()).toBe(0);
  });
 }
 it.each([false, true])("delivers session_start exactly once per boundary (live dispatch=%s)", async live => {
  let initialized = 0, started = 0, selected = 0;
  const h = harness(api => withProviderGate(api, gated => {
   initialized++;
   gated.on("session_start", () => { started++; });
   gated.on("model_select", () => { selected++; });
  }), live);
  const ctx = h.context("custom-openai");
  await h.emit("session_start", ctx);
  expect(initialized).toBe(1); expect(started).toBe(1);
  await h.emit("session_start", ctx);
  expect(initialized).toBe(1); expect(started).toBe(2);
  await h.emit("model_select", ctx);
  expect(selected).toBe(1);
 });
 it("guards late registration and stale callbacks, cleans up once, and requires reload to restart", async () => {
  let gated: any, shutdowns = 0, executed = 0, hooks = 0, signal: AbortSignal | undefined;
  const h = harness(api => withProviderGate(api, proxy => {
   gated = proxy;
   proxy.on("session_start", (_event, ctx) => { signal = ctx.signal; });
   proxy.on("session_shutdown", () => { shutdowns++; });
   for (const name of ["context", "session_before_compact", "before_provider_request"]) gated.on(name, () => { hooks++; return { cancel: true }; });
   gated.registerCommand("test", { handler: () => { executed++; } });
   gated.registerShortcut("ctrl+x", { handler: () => { executed++; } });
   gated.registerTool({ name: "test", execute: () => { executed++; } });
  }));
  const ctx = h.context("openai"); // GPT on a different provider must work.
  await h.emit("session_start", ctx);
  const staleTool = h.tools.get("test");
  await staleTool.execute("id", {}, undefined, undefined, ctx);
  expect(executed).toBe(1);
  gated.registerTool({ name: "late", exposure: "codemode", execute: () => { executed++; } });
  ctx.model = h.context("openai-codex").model;
  await h.emit("model_select", ctx);
  expect(signal?.aborted).toBe(true); expect(shutdowns).toBe(1);
  expect([...h.tools.values()].map(tool => tool.exposure)).toEqual(["hidden", "hidden"]);
  expect(h.active()).toEqual(["read"]);
  expect(() => staleTool.execute("id", {}, undefined, undefined, h.context("openai"))).toThrow("disabled");
  await h.commands.get("test").handler("", ctx);
  await h.shortcuts.get("ctrl+x").handler(ctx);
  for (const name of ["context", "session_before_compact", "before_provider_request"]) expect(await h.emit(name, ctx)).toEqual([undefined]);
  gated.registerTool({ name: "too_late" }); gated.registerCommand("too_late", {}); gated.on("late_event", () => { hooks++; });
  expect(h.tools.has("too_late")).toBe(false); expect(h.commands.has("too_late")).toBe(false); expect(h.handlers.has("late_event")).toBe(false);
  await h.emit("model_select", h.context("openai"));
  await h.emit("session_start", h.context("openai"));
  await h.emit("session_shutdown", ctx);
  expect(shutdowns).toBe(1); expect(executed).toBe(1); expect(hooks).toBe(0);
  expect(h.notices.join(" ")).toContain("/reload");
 });
 it("continues shutdown cleanup after an earlier handler fails", async () => {
  let cleaned = false;
  const h = harness(api => withProviderGate(api, gated => {
   gated.on("session_shutdown", () => { throw new Error("broken cleanup"); });
   gated.on("session_shutdown", () => { cleaned = true; });
   gated.registerTool({ name: "test", execute: () => {} } as any);
  }));
  await h.emit("session_start", h.context("openai"));
  await expect(h.emit("model_select", h.context("openai-codex"))).rejects.toThrow("disable/cleanup failed");
  expect(cleaned).toBe(true);
  expect(h.tools.get("test").exposure).toBe("hidden");
  expect(h.active()).toEqual(["read"]);
 });
 it("still cleans up and blocks execution if the host refuses to hide a tool", async () => {
  let cleaned = false;
  const h = harness(api => withProviderGate(api, gated => {
   gated.on("session_shutdown", () => { cleaned = true; });
   gated.registerTool({ name: "test", execute: () => {} } as any);
  }));
  await h.emit("session_start", h.context("openai"));
  h.api.registerTool = () => { throw new Error("host registration failed"); };
  await expect(h.emit("model_select", h.context("openai-codex"))).rejects.toThrow("disable/cleanup failed");
  expect(cleaned).toBe(true);
  expect(h.active()).toEqual(["read"]);
  expect(() => h.tools.get("test").execute("id", {}, undefined, undefined, h.context("openai"))).toThrow("disabled");
 });
 it("cancels an in-flight tool and prevents a stale command from compacting", async () => {
  let compacted = 0;
  let release!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  let toolSignal: AbortSignal | undefined;
  const h = harness(api => withProviderGate(api, gated => {
   gated.registerTool({ name: "test", async execute(_id: string, _args: unknown, signal: AbortSignal) {
    toolSignal = signal;
    await wait;
   } } as any);
   gated.registerCommand("test", { async handler(_args, ctx) {
    await wait;
    ctx.compact();
   } });
  }));
  const ctx = { ...h.context("openai"), compact: () => { compacted++; } };
  await h.emit("session_start", ctx);
  const tool = h.tools.get("test").execute("id", {}, undefined, undefined, ctx);
  const command = h.commands.get("test").handler("", ctx);
  await h.emit("model_select", h.context("openai-codex"));
  expect(toolSignal?.aborted).toBe(true);
  release();
  await Promise.all([tool, command]);
  expect(compacted).toBe(0);
 });
 it("guards unknown contexts even after successful initialization", async () => {
  let calls = 0;
  const h = harness(api => withProviderGate(api, gated => {
   gated.on("context", () => { calls++; });
   gated.registerCommand("test", { handler: async () => { calls++; } });
  }));
  await h.emit("session_start", h.context("anthropic"));
  await h.emit("context", h.context());
  await h.commands.get("test").handler("", h.context());
  expect(calls).toBe(0);
 });
});
