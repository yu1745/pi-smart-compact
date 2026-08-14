/**
 * Centralized file logger for pi-smart-compact.
 *
 * All diagnostics are appended to a log file — nothing is written to
 * stdout/stderr, so the host terminal/TUI stays clean. Debug lines are
 * gated on the DEBUG env var (e.g. DEBUG=smart-compact).
 *
 * Log file location: `SMART_COMPACT_LOG` env override, otherwise
 * `<cacheDir>/smart-compact.log` (e.g. ~/.pi/agent/.cache/smart-compact/).
 */

import { LOG_PREFIX } from "../constants.ts";
import { smartCompactCacheDir } from "../infra/paths.ts";
import fs from "node:fs";
import path from "node:path";

const DEBUG = process.env.DEBUG?.includes("smart-compact") ?? false;

function logFile(): string {
  const override = process.env.SMART_COMPACT_LOG;
  if (override) return override;
  return path.join(smartCompactCacheDir(), "smart-compact.log");
}

function append(level: string, msg: string): void {
  try {
    const line = LOG_PREFIX + " [" + new Date().toISOString() + "] [" + level + "] " + msg + "\n";
    const file = logFile();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, line, "utf8");
  } catch {
    // Logging must never break the pipeline.
  }
}

export function warn(msg: string, err?: unknown): void {
  const detail = err instanceof Error ? err.message : err ?? "";
  append("warn", msg + (detail ? ": " + detail : ""));
}

export function error(msg: string, err?: unknown): void {
  const detail = err instanceof Error ? err.message + "\n" + err.stack : err ?? "";
  append("error", msg + (detail ? ": " + detail : ""));
}

export function info(msg: string, ...args: unknown[]): void {
  append("info", args.length ? msg + " " + args.map(a => String(a)).join(" ") : msg);
}

export function debug(msg: string, ...args: unknown[]): void {
  if (!DEBUG) return;
  append("debug", args.length ? msg + " " + args.map(a => String(a)).join(" ") : msg);
}

export function debugError(msg: string, err?: unknown): void {
  if (!DEBUG) return;
  error(msg, err);
}
