import { errorMessage, type HookOutcome, type HookHandler, type HookDeps } from "../kernel/types.ts"
import { spawn, type ChildProcess } from "node:child_process"
import { firstNonEmptyLine, parseZeroExitOutput } from "../kernel/decision.ts"
import { handlerPolicyClass } from "../kernel/types.ts"
const DEFAULT_TIMEOUT_SECS = 5
const HARD_TIMEOUT_CAP_SECS = 30

// --- Handler execution ------------------------------------------------------

/**
 * Run one `command` handler: spawn the platform shell with the payload piped to
 * stdin, honour the exit-code/stdout-JSON contract. Never rejects — a broken
 * hook must not lock the user out of the tool.
 *
 * @returns {Promise<object>} an outcome (see extractDecision) or `{ warning }`.
 */
export function runCommandHandler(
  command: string,
  configuredTimeout: number | undefined,
  payloadJson: string,
  signal?: AbortSignal,
  cwd?: string
): Promise<HookOutcome> {
  const timeoutSecs = Math.min(
    typeof configuredTimeout === "number" && configuredTimeout > 0
      ? configuredTimeout
      : DEFAULT_TIMEOUT_SECS,
    HARD_TIMEOUT_CAP_SECS
  )

  return new Promise((resolve) => {
    let child: ChildProcess
    try {
      // `shell: true` runs the command string through the platform shell
      // (`cmd /d /s /c` on Windows, `/bin/sh -c` on POSIX) so pipes, quoting,
      // and `$VAR` expansion behave like the retired Rust `cmd /C` / `sh -c`
      // path — without Node's per-arg quoting mangling nested quotes.
      // `cwd` is the SESSION working directory, not the sidecar's — hooks that
      // run `git diff` / relative-path checks must see the chat's workspace.
      child = spawn(command, {
        shell: true,
        windowsHide: true,
        ...(typeof cwd === "string" && cwd ? { cwd } : {}),
      })
    } catch (e) {
      resolve({ warning: `hook crashed: spawn failed: ${errorMessage(e)}` })
      return
    }

    let stdout = ""
    let stderr = ""
    let settled = false
    const started = Date.now()

    const cleanup = () => {
      clearTimeout(timer)
      if (signal && typeof signal.removeEventListener === "function") {
        signal.removeEventListener("abort", onAbort)
      }
    }
    const finish = (outcome: HookOutcome) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(outcome)
    }
    const kill = () => {
      try {
        if (process.platform === "win32" && child.pid) {
          // `child.kill()` only terminates the `cmd.exe` wrapper spawned by
          // `shell: true`; the actual hook process survives the timeout and
          // leaks. taskkill /T fells the whole tree.
          spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
            windowsHide: true,
            stdio: "ignore",
          }).on("error", () => {})
        } else {
          child.kill()
        }
      } catch {
        // best-effort
      }
    }
    const onAbort = () => {
      finish({ warning: "hook aborted" })
      kill()
    }

    const timer = setTimeout(() => {
      finish({ warning: `hook timed out after ${Date.now() - started}ms (soft-allow)` })
      kill()
    }, timeoutSecs * 1000)

    if (signal) {
      if (signal.aborted) {
        onAbort()
        return
      }
      if (typeof signal.addEventListener === "function") {
        signal.addEventListener("abort", onAbort, { once: true })
      }
    }

    child.stdout?.on("data", (d) => {
      stdout += d.toString()
    })
    child.stderr?.on("data", (d) => {
      stderr += d.toString()
    })
    child.on("error", (e) => finish({ warning: `hook crashed: ${errorMessage(e)}` }))
    child.on("close", (code) => {
      if (code === 2) {
        finish({
          block:
            firstNonEmptyLine(stderr) ?? firstNonEmptyLine(stdout) ?? "hook denied (no message)",
        })
      } else if (code === 0) {
        finish(parseZeroExitOutput(stdout))
      } else {
        finish({ warning: firstNonEmptyLine(stderr) ?? `hook exited with code ${code}` })
      }
    })

    // A hook that exits without reading stdin (very common) fails the write
    // ASYNCHRONOUSLY with EPIPE, emitted as an 'error' event on the stdin
    // stream — NOT on the child (so `child.on("error")` never sees it) and NOT
    // in the sync try/catch below. Unhandled, it crashes the whole sidecar.
    child.stdin?.on("error", () => {})
    try {
      child.stdin?.write(payloadJson)
      child.stdin?.end()
    } catch {
      // child may have exited early; the close/error handler resolves us.
    }
  })
}

/**
 * Run one `command` handler with `async: true` — fire-and-forget. The payload
 * is still piped on stdin, but the child is spawned detached, never awaited,
 * and its stdout/stderr are discarded, so it can neither block nor inject
 * context. `detached` (POSIX) keeps it out of the parent's signal group and
 * `unref` keeps it from holding the sidecar's event loop open, so an async
 * hook may outlive the turn it fired on.
 *
 * Resolves immediately: `{}` on a successful spawn, `{ warning }` when the
 * spawn itself throws. Post-spawn failures (the async `error` event, a
 * non-zero exit) are reported through the audit channel when one is wired —
 * diagnostics only, never a decision.
 *
 * @returns {{}|{warning: string}} an outcome that never carries a decision.
 */
export function runCommandDetached(
  handler: HookHandler & { command: string },
  payloadJson: string,
  cwd: string | undefined,
  deps: HookDeps
): HookOutcome {
  let child: ChildProcess
  try {
    child = spawn(handler.command, {
      shell: true,
      windowsHide: true,
      detached: process.platform !== "win32",
      stdio: ["pipe", "ignore", "ignore"],
      ...(typeof cwd === "string" && cwd ? { cwd } : {}),
    })
  } catch (e) {
    return { warning: `async hook failed to spawn: ${errorMessage(e)}` }
  }

  const report = (error: string) => {
    if (typeof deps?.onAudit !== "function") return
    deps.onAudit({
      hookId: `${deps.sessionId ?? "session"}:${deps.eventName ?? "event"}:${Date.now()}:async`,
      hookEvent: deps.eventName ?? "unknown",
      provider: deps.provider ?? "unknown",
      handlerType: "command",
      policyClass: handlerPolicyClass(handler),
      outcome: "warning",
      latencyMs: 0,
      redacted: false,
      error,
    })
  }
  child.on("error", (e) => report(`async hook crashed: ${errorMessage(e)}`))
  child.on("close", (code) => {
    if (code !== 0 && code !== null) report(`async hook exited with code ${code}`)
  })
  // stdin stays piped (the payload contract still holds) but a child that
  // exits before the write lands must not crash the sidecar with an EPIPE.
  child.stdin?.on("error", () => {})
  try {
    child.stdin?.write(payloadJson)
    child.stdin?.end()
  } catch {
    // child may have exited early; the close/error handlers report if needed.
  }
  child.unref()
  return {}
}
