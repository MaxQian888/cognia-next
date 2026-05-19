/**
 * lark-cli execFile wrapper (ADR-0026).
 *
 * Spawns the user's installed lark-cli binary with argv directly — no
 * shell interpolation. Caps mirror `sidecar/builtin-tools/shell-advanced.mjs`:
 *   - 5-minute timeout (skill caller may shorten)
 *   - 1 MB stdout cap (lark-cli list/search responses can be sizeable)
 *   - `windowsHide: true` so no console window flashes on Windows
 *
 * Returns a structured `LarkCliResult`:
 *   - `ok` payload — parsed JSON when stdout starts with `{` or `[`;
 *                    raw string otherwise.
 *   - `error` payload — exit code, stderr, signal, timedOut flag.
 *
 * The helper deliberately does NOT short-circuit on exit code `10`
 * (lark-cli's "confirmation required" signal). The built-in skill
 * dispatcher owns HITL — by the time we shell to lark-cli we've
 * already routed through the confirm-card path, so the helper just
 * always passes `--yes` when the caller marks the invocation as
 * confirmed. Skills that don't pass `confirmed: true` and receive
 * exit 10 surface that as a structured error so the assistant can
 * decide whether to re-prompt.
 *
 * Binary discovery (cross-platform):
 *   1. `process.env.LARK_CLI_BIN` — explicit override, used in tests.
 *   2. PATH lookup via `which` / `where` semantics inside `execFile`
 *      (Node 18+ resolves PATH transparently).
 *   3. Windows-only fallback: `%APPDATA%\npm\lark-cli.cmd` (where the
 *      `lark-cli` npm package installs itself globally).
 */

import { execFile } from "node:child_process"
import { promisify } from "node:util"
import fs from "node:fs"
import path from "node:path"
import os from "node:os"

import { resolveLarkAuth, type LarkAuthBridgeResult } from "./auth-bridge"

const execFileAsync = promisify(execFile)

const MAX_STDOUT_BYTES = 1024 * 1024 // 1 MB
const DEFAULT_TIMEOUT_MS = 60_000
const MAX_TIMEOUT_MS = 5 * 60 * 1000

const LARK_CLI_EXIT_HITL_REQUIRED = 10

export interface ExecLarkCliInput {
  /**
   * Subcommand argv excluding the binary name. e.g.
   *   ["calendar", "+list-events", "--calendar-id", "cal_1", "--json"]
   */
  args: readonly string[]
  /** Per-call timeout (clamped to MAX_TIMEOUT_MS). */
  timeoutMs?: number
  /**
   * Pass `--yes` when set. The dispatcher sets this on the HITL-bypass
   * re-fire path so lark-cli's own confirmation gate is satisfied.
   */
  confirmed?: boolean
  /** Override the auth bridge identity (defaults to user). */
  identity?: "user" | "bot"
  /**
   * Explicit adapter id. When omitted, the auth bridge picks the first
   * enabled Lark adapter.
   */
  adapterId?: string
  /**
   * Test override — when set, the helper uses this object instead of
   * calling `resolveLarkAuth`. Bypasses Dexie + keyring so unit tests
   * don't need a full database fixture.
   */
  __authOverride?: LarkAuthBridgeResult
}

export type LarkCliResult =
  | {
      status: "ok"
      adapterId: string
      identity: "user" | "bot"
      /** Parsed JSON when stdout begins `{`/`[`; raw string otherwise. */
      data: unknown
      stderr: string
      durationMs: number
    }
  | {
      status: "error"
      reason:
        | "auth_unavailable"
        | "binary_not_found"
        | "non_zero_exit"
        | "hitl_required"
        | "timeout"
        | "json_parse_failed"
      message: string
      exitCode?: number
      stderr?: string
      adapterId?: string
    }

export async function execLarkCli(input: ExecLarkCliInput): Promise<LarkCliResult> {
  const auth =
    input.__authOverride ??
    (await resolveLarkAuth({
      adapterId: input.adapterId,
      identity: input.identity,
    }))
  if (!auth.ok) {
    return {
      status: "error",
      reason: "auth_unavailable",
      message: auth.message,
      adapterId: "adapterId" in auth ? auth.adapterId : undefined,
    }
  }

  const binary = locateLarkCliBinary()
  if (!binary) {
    return {
      status: "error",
      reason: "binary_not_found",
      message:
        "lark-cli binary not found on PATH. Install via `npm install -g lark-cli` or set LARK_CLI_BIN.",
      adapterId: auth.adapterId,
    }
  }

  const argv: string[] = [...input.args]
  // lark-cli expects the identity flag up front. We bias to user-scope
  // when the bridge selected `"user"`; bot-scope falls through to the
  // tenant_access_token path the CLI reads from env.
  if (!argv.includes("--as")) {
    argv.unshift("--as", auth.identity)
  }
  if (input.confirmed && !argv.includes("--yes")) {
    argv.push("--yes")
  }

  const timeoutMs = Math.min(MAX_TIMEOUT_MS, Math.max(1000, input.timeoutMs ?? DEFAULT_TIMEOUT_MS))
  const start = Date.now()
  try {
    const result = await execFileAsync(binary, argv, {
      env: { ...process.env, ...auth.env },
      timeout: timeoutMs,
      maxBuffer: MAX_STDOUT_BYTES,
      windowsHide: true,
    })
    const data = tryParseJson(String(result.stdout))
    return {
      status: "ok",
      adapterId: auth.adapterId,
      identity: auth.identity,
      data,
      stderr: String(result.stderr ?? ""),
      durationMs: Date.now() - start,
    }
  } catch (err) {
    return interpretError(err, auth.adapterId)
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Test escape hatch. */
export function __setLarkCliBinaryForTests(path: string | null): void {
  testBinaryOverride = path
}
let testBinaryOverride: string | null = null

function locateLarkCliBinary(): string | null {
  if (testBinaryOverride) return testBinaryOverride
  const fromEnv = process.env.LARK_CLI_BIN?.trim()
  if (fromEnv && fileExists(fromEnv)) return fromEnv
  // PATH lookup — Node's execFile resolves binary names through PATH on
  // POSIX without intervention. On Windows we need the `.cmd` shim.
  if (process.platform === "win32") {
    const candidate = path.join(
      process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"),
      "npm",
      "lark-cli.cmd"
    )
    if (fileExists(candidate)) return candidate
    return "lark-cli.cmd"
  }
  return "lark-cli"
}

function fileExists(p: string): boolean {
  try {
    return fs.statSync(p).isFile()
  } catch {
    return false
  }
}

function tryParseJson(stdout: string): unknown {
  const trimmed = stdout.trim()
  if (!trimmed) return null
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed)
    } catch {
      // Fall through to return raw — caller can decide.
    }
  }
  return trimmed
}

interface ExecError extends Error {
  code?: number | string
  stdout?: string
  stderr?: string
  signal?: NodeJS.Signals
  killed?: boolean
}

function interpretError(err: unknown, adapterId: string): LarkCliResult {
  const e = err as ExecError
  const stderr = String(e?.stderr ?? "")
  const exitCode = typeof e?.code === "number" ? e.code : undefined
  if (e?.killed || e?.signal === "SIGTERM") {
    return {
      status: "error",
      reason: "timeout",
      message: "lark-cli timed out.",
      stderr,
      adapterId,
    }
  }
  if (typeof e?.code === "string" && e.code === "ENOENT") {
    return {
      status: "error",
      reason: "binary_not_found",
      message: "lark-cli binary not found (ENOENT).",
      adapterId,
    }
  }
  if (exitCode === LARK_CLI_EXIT_HITL_REQUIRED) {
    return {
      status: "error",
      reason: "hitl_required",
      message:
        "lark-cli reported confirmation required (exit 10). Re-invoke with confirmed:true after user approves the confirm card.",
      exitCode,
      stderr,
      adapterId,
    }
  }
  return {
    status: "error",
    reason: "non_zero_exit",
    message: e?.message ?? `lark-cli exited with code ${exitCode}.`,
    exitCode,
    stderr,
    adapterId,
  }
}
