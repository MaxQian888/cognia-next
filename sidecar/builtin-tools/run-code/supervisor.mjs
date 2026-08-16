// Sandbox supervisor for the Code tool presentation (ADR-0117, Phase 4).
//
// Owns everything the child cannot be trusted to own: whether a sandbox exists
// at all, which tools may be called, how many times, for how long, and how big
// the answer may be. The child asks; this decides.
//
// The fail-closed rule is enforced in exactly one place — `assertSandboxable()`
// — and there is no option, flag, or environment variable that turns it into a
// warning. "Run it unsandboxed just this once" is the failure this design
// exists to make unrepresentable.

import { fork, spawn } from "node:child_process"
import { fileURLToPath } from "node:url"

import limits from "../../../lib/ai/code-mode/limits.json" with { type: "json" }
import { checkToolEligibility, programmaticReadOnlyToolNames } from "./eligibility.mjs"
import { CHILD_MESSAGE_KINDS } from "./sandbox-child.mjs"

const CHILD_PATH = fileURLToPath(new URL("./sandbox-child.mjs", import.meta.url))

export { limits as CODE_MODE_LIMITS }

/** Thrown when the strict sandbox is unavailable. Never downgraded to a warning. */
export class SandboxUnavailableError extends Error {
  /** @param {"no-fork" | "no-strict-sandbox" | "no-workdir"} reason */
  constructor(reason) {
    super(`Code mode requires a strict sandbox (${reason})`)
    this.name = "SandboxUnavailableError"
    this.reason = reason
  }
}

/**
 * Env var carrying the OS-confinement launcher, as a JSON argv array.
 *
 * The host (Rust, which owns `crate::sandbox` and knows whether the backend is
 * `macos-sandbox-exec`, `linux-bwrap`, or absent) renders the wrapper argv and
 * hands it over at sidecar spawn. Example:
 * `["/usr/bin/sandbox-exec","-f","/path/profile.sb"]`.
 *
 * This is deliberately a *mechanism*, not a boolean. An earlier version keyed
 * strictness off a bare `COGNIA_STRICT_SANDBOX=1` flag, which was a claim
 * anybody could set without any confinement existing — and since the sidecar
 * itself runs unconfined (it needs network to reach the model), a child forked
 * from it inherits nothing. Requiring the argv means "strict" is true exactly
 * when there is a real wrapper to exec through.
 */
export const SANDBOX_LAUNCHER_ENV = "COGNIA_CODE_SANDBOX_LAUNCHER"

/**
 * Parse the launcher argv. Returns `null` when absent or malformed.
 *
 * Malformed is treated as absent rather than as an error, because the
 * consequence of "absent" is failing closed — the safe direction — whereas
 * throwing here would turn a misconfigured host into a crash.
 *
 * @param {string | undefined} raw
 * @returns {string[] | null}
 */
export function parseSandboxLauncher(raw) {
  if (typeof raw !== "string" || raw.trim() === "") return null
  try {
    const argv = JSON.parse(raw)
    if (!Array.isArray(argv) || argv.length === 0) return null
    if (!argv.every((part) => typeof part === "string" && part.length > 0)) return null
    return argv
  } catch {
    return null
  }
}

/**
 * Probe the host.
 *
 * Returns the same shape `lib/ai/code-mode/availability.ts` consumes, so the
 * renderer's "is Code offered?" and the sidecar's "may I spawn?" answer the
 * same question from the same evidence.
 *
 * @param {{ fork?: unknown, launcher?: string[] | null }} [overrides] injected in tests
 */
export function probeSandbox(overrides = {}) {
  const canSpawnProcess =
    overrides.fork !== undefined ? Boolean(overrides.fork) : typeof fork === "function"
  const launcher =
    overrides.launcher !== undefined
      ? overrides.launcher
      : parseSandboxLauncher(process.env[SANDBOX_LAUNCHER_ENV])
  return { canSpawnProcess, strictSandbox: Array.isArray(launcher), launcher: launcher ?? null }
}

/** @param {{ canSpawnProcess: boolean, strictSandbox: boolean }} probe */
export function assertSandboxable(probe) {
  if (!probe?.canSpawnProcess) throw new SandboxUnavailableError("no-fork")
  if (!probe.strictSandbox) throw new SandboxUnavailableError("no-strict-sandbox")
}

/**
 * The environment the child gets.
 *
 * Built by construction rather than by deleting keys from `process.env`: the
 * sidecar's environment carries ANTHROPIC_API_KEY and CLAUDE_CODE_OAUTH_TOKEN,
 * and a deny-list would leak every future secret nobody remembered to add.
 */
export function sandboxEnv() {
  return {
    COGNIA_CODE_SANDBOX_CHILD: "1",
    // Node itself needs almost nothing. NODE_ENV is passed so the child's
    // runtime assertions behave the same as the rest of the sidecar.
    NODE_ENV: process.env.NODE_ENV === "production" ? "production" : "development",
  }
}

/**
 * Tracks the two budgets that only exist while a program runs.
 *
 * Mirrors `CodeCallBudget` in `lib/ai/code-mode/limits.ts`; both read the same
 * JSON so the numbers cannot diverge.
 */
export class CallBudget {
  constructor(config = limits) {
    this.config = config
    this.used = 0
    this.inFlight = 0
  }

  get callsUsed() {
    return this.used
  }

  tryAcquire() {
    if (this.used >= this.config.maxToolCalls) {
      return { ok: false, exceeded: { kind: "tool-calls", limit: this.config.maxToolCalls } }
    }
    if (this.inFlight >= this.config.maxConcurrency) return { ok: false, retry: true }
    this.used += 1
    this.inFlight += 1
    return { ok: true }
  }

  release() {
    this.inFlight = Math.max(0, this.inFlight - 1)
  }
}

/**
 * Run one program.
 *
 * @param {object} options
 * @param {string} options.source
 * @param {(name: string, input: unknown) => Promise<unknown>} options.callTool
 *        Re-enters the host's real tool registry. The supervisor never touches
 *        a tool implementation directly — argument validation, permissions,
 *        confinement, and the canonical event log all live behind this call.
 * @param {{ canSpawnProcess: boolean, strictSandbox: boolean }} [options.probe]
 * @param {object} [options.config] limit overrides, for tests
 * @param {(level: string, text: string) => void} [options.onLog]
 * @returns {Promise<{ ok: true, result: unknown, callsUsed: number, logs: Array<{level: string, text: string}> }
 *   | { ok: false, error: { name: string, message: string }, limit?: object, callsUsed: number, logs: Array<{level: string, text: string}> }>}
 */
export async function runCodeProgram({ source, callTool, probe, config = limits, onLog }) {
  const resolvedProbe = probe ?? probeSandbox()
  assertSandboxable(resolvedProbe)

  const sourceBytes = Buffer.byteLength(source ?? "", "utf8")
  if (sourceBytes > config.maxSourceBytes) {
    return failure("source-too-large", config.maxSourceBytes, sourceBytes)
  }

  const budget = new CallBudget(config)
  const logs = []
  const toolNames = programmaticReadOnlyToolNames()
  const nodeArgs = [
    `--max-old-space-size=${Math.floor(config.maxMemoryBytes / (1024 * 1024))}`,
    CHILD_PATH,
  ]
  const spawnOptions = {
    // No `cwd` override on purpose. The launcher's policy defines the child's
    // filesystem view — `bwrap` chdirs into its own scratch bind, and the
    // macOS profile scopes reads and writes explicitly. An earlier version
    // created its own `mkdtemp` here, which the host-rendered policy knew
    // nothing about, so the child started in a directory the profile did not
    // grant. Letting the confinement own the cwd removes the mismatch instead
    // of duplicating a path convention across Rust and Node.
    env: sandboxEnv(),
    // The child must not inherit the sidecar's stdio: its stdout would
    // interleave with the sidecar's own protocol stream. Slot 3 is the IPC
    // channel; both `bwrap` and `sandbox-exec` pass inherited fds through, so
    // the tool-call protocol survives the confinement wrapper.
    stdio: ["ignore", "pipe", "pipe", "ipc"],
  }

  const child = resolvedProbe.launcher
    ? spawn(
        resolvedProbe.launcher[0],
        [...resolvedProbe.launcher.slice(1), process.execPath, ...nodeArgs],
        spawnOptions
      )
    : // Unreachable: `assertSandboxable` already rejected a probe with no
      // launcher. Kept as a throw rather than a `fork` fallback so that a future
      // edit to the assertion cannot silently reintroduce an unconfined path.
      (() => {
        throw new SandboxUnavailableError("no-strict-sandbox")
      })()

  let settled = false
  let timer = null

  const cleanup = () => {
    if (timer) clearTimeout(timer)
    try {
      child.kill("SIGKILL")
    } catch {
      /* already gone */
    }
  }

  return await new Promise((resolve) => {
    const settle = (value) => {
      if (settled) return
      settled = true
      cleanup()
      resolve({ ...value, callsUsed: budget.callsUsed, logs })
    }

    timer = setTimeout(() => {
      settle({
        ok: false,
        error: { name: "CodeLimitExceeded", message: "wall time exceeded" },
        limit: { kind: "wall-time", limit: config.wallTimeMs },
      })
    }, config.wallTimeMs)

    child.on("error", (error) => {
      settle({
        ok: false,
        error: { name: "SandboxError", message: String(error?.message ?? error) },
      })
    })

    child.on("exit", (code, signal) => {
      // An exit before a DONE/FAILED message means the child died — OOM kill
      // lands here, and reporting it as a crash rather than as a result is the
      // difference between "the limit worked" and "the answer was empty".
      settle({
        ok: false,
        error: {
          name: "SandboxError",
          message: `sandbox exited unexpectedly (code=${code}, signal=${signal})`,
        },
      })
    })

    child.on("message", (message) => {
      if (!message || typeof message !== "object") return

      switch (message.kind) {
        case CHILD_MESSAGE_KINDS.READY:
          child.send({ kind: CHILD_MESSAGE_KINDS.START, source, toolNames })
          return

        case CHILD_MESSAGE_KINDS.LOG:
          logs.push({ level: String(message.level), text: String(message.text) })
          onLog?.(String(message.level), String(message.text))
          return

        case CHILD_MESSAGE_KINDS.TOOL_CALL:
          void handleToolCall(message)
          return

        case CHILD_MESSAGE_KINDS.DONE: {
          const serialized = safeStringify(message.result)
          if (Buffer.byteLength(serialized, "utf8") > config.maxResultBytes) {
            settle({
              ok: false,
              error: { name: "CodeLimitExceeded", message: "result too large" },
              limit: {
                kind: "result-too-large",
                limit: config.maxResultBytes,
                observed: Buffer.byteLength(serialized, "utf8"),
              },
            })
            return
          }
          settle({ ok: true, result: message.result })
          return
        }

        case CHILD_MESSAGE_KINDS.FAILED:
          settle({ ok: false, error: message.error ?? { name: "Error", message: "unknown" } })
          return

        default:
          return
      }
    })

    async function handleToolCall(message) {
      const reply = (patch) => {
        if (settled) return
        child.send({ kind: CHILD_MESSAGE_KINDS.TOOL_RESULT, id: message.id, ...patch })
      }

      // The allowlist is re-checked here even though the child was only handed
      // eligible names. The child is the untrusted side; a name it invents must
      // die at this boundary, not at the registry.
      const eligibility = checkToolEligibility(message.name)
      if (!eligibility.allowed) {
        reply({ error: `tool "${message.name}" is not callable from code (${eligibility.reason})` })
        return
      }

      const slot = budget.tryAcquire()
      if (!slot.ok && slot.exceeded) {
        settle({
          ok: false,
          error: { name: "CodeLimitExceeded", message: "tool call budget exhausted" },
          limit: slot.exceeded,
        })
        return
      }
      if (!slot.ok) {
        reply({ error: "too many concurrent tool calls; await earlier calls first" })
        return
      }

      try {
        const result = await callTool(message.name, message.input)
        reply({ result })
      } catch (error) {
        reply({ error: String(error?.message ?? error) })
      } finally {
        budget.release()
      }
    }
  })
}

function failure(kind, limit, observed) {
  return {
    ok: false,
    error: { name: "CodeLimitExceeded", message: kind },
    limit: { kind, limit, observed },
    callsUsed: 0,
    logs: [],
  }
}

function safeStringify(value) {
  try {
    return JSON.stringify(value ?? null) ?? "null"
  } catch {
    return String(value)
  }
}
