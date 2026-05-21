/**
 * ADR-0028 / T4 — e2b microVM exec adapter.
 *
 * Registered with `lib/sandbox/microvm-bridge.ts:setMicrovmExec` on plugin
 * activate. The `cognia-sandboxed-tools` plugin calls into it when the
 * active session resolves to the `"microvm"` tier; otherwise calls stay
 * on the OS sandbox tier via the `sandbox_exec` Tauri command.
 *
 * Each call provisions a fresh sandbox, runs the requested argv (joined
 * via `bash -c` so quoting semantics match the OS backend), closes the
 * sandbox, and returns a `MicrovmResult` shaped like the OS sandbox's
 * `SandboxResult`.
 *
 * Why a separate file:
 *   - Keeps `@e2b/sdk` an optional dynamic-import so platforms / users
 *     without the SDK installed still get a clean install-hint error
 *     instead of a build failure.
 *   - Lets tests inject a `sandboxFactory` without touching the live
 *     dynamic-import path.
 */

import type { MicrovmExec, MicrovmExecPayload, MicrovmResult } from "@/lib/sandbox/microvm-bridge"

import type { E2BSandboxFacade, E2BSandboxFactory } from "./workspace-backend"

export interface MicrovmExecOptions {
  /** API key forwarded to the sandbox factory. */
  apiKey?: string
  /** Factory override — tests inject a mock here. */
  sandboxFactory?: E2BSandboxFactory
  /** Override `Date.now()` for deterministic timing in tests. */
  now?: () => number
}

/**
 * Build a microvm exec function bound to the given options. The returned
 * function matches `MicrovmExec` so it can be passed to
 * `setMicrovmExec`.
 */
export function buildMicrovmExec(opts: MicrovmExecOptions = {}): MicrovmExec {
  const factory = opts.sandboxFactory ?? defaultMicrovmSandboxFactory
  const now = opts.now ?? Date.now

  return async function microvmExec(payload: MicrovmExecPayload): Promise<MicrovmResult> {
    const started = now()
    const sandbox = await factory({ apiKey: opts.apiKey ?? process.env.E2B_API_KEY })
    try {
      const cmd = buildBashCommand(payload)
      const result = await sandbox.exec({
        cmd,
        cwd: payload.command.cwd,
        timeoutMs: payload.command.timeout > 0 ? payload.command.timeout * 1000 : undefined,
      })
      return {
        exit_code: result.exitCode,
        stdout: result.stdout,
        stderr: result.stderr,
        duration: Math.max(0, now() - started),
        timed_out: false,
      }
    } catch (err) {
      // Surface the cause through stderr so the model sees the actual
      // reason. Matches the OS backend's error reporting shape.
      const message = err instanceof Error ? err.message : String(err)
      return {
        exit_code: -1,
        stdout: "",
        stderr: message,
        duration: Math.max(0, now() - started),
        timed_out: /timed?[ _-]?out/i.test(message),
      }
    } finally {
      await sandbox.close().catch(() => undefined)
    }
  }
}

/**
 * Translate a `MicrovmExecPayload` to a single `bash -c` string. The OS
 * sandbox path runs `argv[0] argv[1] …`; e2b's `exec` takes a single
 * command string, so we join with `bash -c` and let bash parse argv. Env
 * vars are exported inline.
 */
function buildBashCommand(payload: MicrovmExecPayload): string {
  const envExports = Object.entries(payload.command.env)
    .map(([k, v]) => `export ${escapeShellName(k)}=${escapeShellArg(v)};`)
    .join(" ")
  const argv = payload.command.argv.map(escapeShellArg).join(" ")
  // Stdin (if any) is piped through `<<<` so the runner can read it.
  const stdinPipe = payload.command.stdin ? ` <<< ${escapeShellArg(payload.command.stdin)}` : ""
  return `${envExports} ${argv}${stdinPipe}`.trim()
}

function escapeShellArg(value: string): string {
  // Single-quote and escape inner single quotes — safe under bash.
  return `'${value.replace(/'/g, `'"'"'`)}'`
}

function escapeShellName(name: string): string {
  // Env var names: `[A-Za-z_][A-Za-z0-9_]*`. Anything else gets dropped by
  // bash; we strip invalid characters so a sneaky env entry can't break
  // out of the assignment.
  return name.replace(/[^A-Za-z0-9_]/g, "")
}

/**
 * Dynamic-import-based default factory. Mirrors `workspace-backend.ts`'s
 * approach: surfaces a single-line install hint when `@e2b/sdk` isn't
 * present, so users opting into the microvm tier without the SDK get a
 * clean strict-mode failure rather than a build break.
 */
async function defaultMicrovmSandboxFactory(opts: { apiKey?: string }): Promise<E2BSandboxFacade> {
  let mod: { Sandbox?: unknown } | undefined
  try {
    mod = (await (Function("s", "return import(s)") as (s: string) => Promise<unknown>)(
      "@e2b/sdk"
    )) as { Sandbox?: unknown }
  } catch {
    throw new Error(
      "@e2b/sdk is not installed. Install it with `pnpm add @e2b/sdk -w` and set " +
        "E2B_API_KEY to use the microVM sandbox tier."
    )
  }
  const SandboxCtor = mod?.Sandbox as
    | { create?: (opts: unknown) => Promise<E2BSandboxFacade> }
    | undefined
  if (!SandboxCtor || typeof SandboxCtor.create !== "function") {
    throw new Error("@e2b/sdk does not export `Sandbox.create` — incompatible SDK version")
  }
  return SandboxCtor.create({ apiKey: opts.apiKey })
}
