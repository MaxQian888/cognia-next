/**
 * The CLI's OS-tier sandbox executor (ADR-0028 / T1).
 *
 * On the desktop the OS tier is `transport.call("sandbox_exec")`, a Tauri
 * `invoke`. The CLI's transport is stdio to the sidecar and answers
 * `unsupported command "sandbox_exec"`, so the tier had no implementation here
 * at all. This runs the same confinement through `cognia-sandbox-exec`, the
 * one-shot binary built from `crates/cognia-automation`, which calls the very
 * `run_confined` the Tauri command calls. Confinement is therefore identical
 * rather than reimplemented: policy resolution, path canonicalization, the
 * forbidden-root floor, env scrubbing, seccomp / rlimits and output capping all
 * live on the Rust side and are not duplicated here.
 *
 * This module is transport only. It serialises the payload, spawns, and maps
 * the envelope back. It makes no policy decisions.
 *
 * An executor is registered even when the binary is missing. Registering
 * nothing would leave the caller with the stdio transport's
 * `unsupported command` error, which tells an operator nothing. Refusing here
 * with the reason and the remedy is the same fail-closed outcome, said out loud.
 */

import { spawn } from "node:child_process"

import type { OsSandboxExecutor } from "@/lib/sandbox/os-exec-bridge"
import type { CodeSandboxStatus } from "@/lib/ai/code-mode/sandbox-status"
import type { MicrovmExecPayload, MicrovmResult } from "@cognia/plugin-sdk/api/sandbox"

import {
  defaultNativeCandidates,
  findNativeBinary,
  isDevCheckout as isRepoCheckout,
} from "../native-binary"

export const SANDBOX_EXEC_BASE_NAME = "cognia-sandbox-exec"
export const SANDBOX_EXEC_ENV = "COGNIA_SANDBOX_EXEC"

/**
 * Grace added to the policy's own timeout before the wrapper gives up.
 *
 * The Rust side already kills the confined process tree on its deadline and
 * returns a result with `timed_out: true`, which is the answer we want. The
 * wrapper deadline only exists for a supervisor that itself wedged, so it has
 * to be strictly later or it would race the useful answer away.
 */
export const SUPERVISOR_GRACE_MS = 30_000

/** Ceiling on the envelope we will buffer. Each output stream is already capped
 * at one million bytes on the Rust side, so anything past this is a protocol
 * fault rather than a large-but-legitimate result. */
export const MAX_ENVELOPE_BYTES = 8 * 1024 * 1024

interface RawSandboxError {
  kind?: string
  reason?: string
  seconds?: number
}

interface RawEnvelope {
  ok?: boolean
  result?: MicrovmResult
  error?: RawSandboxError
  probe?: { backend?: string; confined?: boolean; detail?: string }
}

/**
 * Render a `SandboxError` exactly as the Rust `#[error]` strings do.
 *
 * The desktop surfaces `err.to_string()` verbatim to the model through the
 * plugin's ToolResult. Reproducing the same text means a refusal reads the same
 * on both rails instead of the CLI inventing its own phrasing for the same
 * condition.
 */
export function formatSandboxError(error: RawSandboxError | undefined): string {
  const reason = error?.reason ?? ""
  switch (error?.kind) {
    case "unavailable":
      return `sandbox unavailable: ${reason}`
    case "setup_required":
      return `sandbox setup required: ${reason}`
    case "invalid_policy":
      return `invalid policy: ${reason}`
    case "backend_failed":
      return `backend failed: ${reason}`
    case "timeout":
      return `timeout after ${error?.seconds ?? 0}s`
    default:
      return reason || "the sandbox refused the call without a reason"
  }
}

export function sandboxExecUnavailableMessage(devCheckout: boolean): string {
  const base =
    `The OS sandbox is unavailable: the "${SANDBOX_EXEC_BASE_NAME}" helper was not found. ` +
    `Cognia does not run a sandboxed tool call outside the sandbox, so this call was refused. ` +
    `Reinstall cognia-agent, or point ${SANDBOX_EXEC_ENV} at a built helper.`
  return devCheckout ? `${base} (repo checkout: run \`pnpm cli:sandbox-exec:build\`)` : base
}

/** Locate the helper, or `undefined` when this install does not carry one. */
export function findSandboxExecBinary(
  candidates: readonly string[] = defaultNativeCandidates({
    base: SANDBOX_EXEC_BASE_NAME,
    envVar: SANDBOX_EXEC_ENV,
    moduleUrl: import.meta.url,
  }),
  executable?: (candidate: string) => boolean
): string | undefined {
  return findNativeBinary(candidates, executable)
}

/** Minimal spawned-process surface, so the executor unit-tests without a binary. */
export interface SandboxExecChild {
  stdin: { write(chunk: string): void; end(): void } | null
  stdout: { on(event: "data", cb: (chunk: Buffer | string) => void): void } | null
  stderr: { on(event: "data", cb: (chunk: Buffer | string) => void): void } | null
  on(event: "close", cb: (code: number | null) => void): void
  on(event: "error", cb: (err: Error) => void): void
  kill(signal?: NodeJS.Signals): void
}

export type SandboxExecSpawn = (binary: string, args: readonly string[]) => SandboxExecChild

export interface NodeOsSandboxExecutorDeps {
  /** Resolved helper path, or undefined when this install has none. */
  binary?: string | undefined
  spawn?: SandboxExecSpawn
  devCheckout?: boolean
  /** Injected in tests so a wrapper deadline is reachable without waiting. */
  supervisorGraceMs?: number
}

const realSpawn: SandboxExecSpawn = (binary, args) =>
  spawn(binary, [...args], { stdio: ["pipe", "pipe", "pipe"] }) as unknown as SandboxExecChild

/**
 * Run the helper once and return its parsed envelope.
 *
 * Every failure mode collapses onto a thrown Error with an operator-readable
 * message. A silently-resolved value would be read as a successful, unconfined
 * run by the tool that called it, which is the one outcome ADR-0028 forbids.
 */
async function runHelper(
  binary: string,
  args: readonly string[],
  stdinPayload: string | null,
  spawnFn: SandboxExecSpawn,
  deadlineMs: number | null
): Promise<RawEnvelope> {
  return new Promise<RawEnvelope>((resolve, reject) => {
    let child: SandboxExecChild
    try {
      child = spawnFn(binary, args)
    } catch (err) {
      reject(new Error(`failed to start ${SANDBOX_EXEC_BASE_NAME}: ${describe(err)}`))
      return
    }

    let stdout = ""
    let stderr = ""
    let overflowed = false
    let settled = false
    let timer: ReturnType<typeof setTimeout> | null = null

    const finish = (fn: () => void): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      fn()
    }

    child.stdout?.on("data", (chunk) => {
      if (overflowed) return
      stdout += String(chunk)
      if (stdout.length > MAX_ENVELOPE_BYTES) {
        overflowed = true
        stdout = ""
        child.kill("SIGKILL")
      }
    })
    child.stderr?.on("data", (chunk) => {
      // Bounded by the same ceiling: a helper spewing to stderr must not grow
      // the supervisor's heap without limit.
      if (stderr.length <= MAX_ENVELOPE_BYTES) stderr += String(chunk)
    })

    child.on("error", (err) => {
      finish(() => reject(new Error(`failed to start ${SANDBOX_EXEC_BASE_NAME}: ${describe(err)}`)))
    })

    child.on("close", (code) => {
      finish(() => {
        if (overflowed) {
          reject(
            new Error(
              `${SANDBOX_EXEC_BASE_NAME} produced more than ${MAX_ENVELOPE_BYTES} bytes of output`
            )
          )
          return
        }
        const trimmed = stdout.trim()
        if (!trimmed) {
          const detail = stderr.trim() || `exit code ${code ?? "unknown"}`
          reject(new Error(`${SANDBOX_EXEC_BASE_NAME} returned no response: ${detail}`))
          return
        }
        try {
          resolve(JSON.parse(trimmed) as RawEnvelope)
        } catch (err) {
          reject(
            new Error(
              `${SANDBOX_EXEC_BASE_NAME} returned an unparseable response: ${describe(err)}`
            )
          )
        }
      })
    })

    if (deadlineMs !== null) {
      timer = setTimeout(() => {
        child.kill("SIGKILL")
        finish(() =>
          reject(
            new Error(
              `${SANDBOX_EXEC_BASE_NAME} did not answer within ${deadlineMs}ms and was killed`
            )
          )
        )
      }, deadlineMs)
      // A supervisor deadline must not by itself keep the process alive.
      timer.unref?.()
    }

    if (stdinPayload !== null) {
      try {
        child.stdin?.write(stdinPayload)
        child.stdin?.end()
      } catch (err) {
        child.kill("SIGKILL")
        finish(() => reject(new Error(`failed to send the sandbox request: ${describe(err)}`)))
      }
    } else {
      child.stdin?.end()
    }
  })
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Build the CLI's OS-tier executor.
 *
 * Each call spawns its own helper process and shares no state with any other,
 * so concurrent tool calls cannot interfere. Serialisation, where it is wanted,
 * is the broker's execution-slot concern and not this layer's.
 */
export function createNodeOsSandboxExecutor(
  deps: NodeOsSandboxExecutorDeps = {}
): OsSandboxExecutor {
  const binary = "binary" in deps ? deps.binary : findSandboxExecBinary()
  const spawnFn = deps.spawn ?? realSpawn
  const devCheckout = deps.devCheckout ?? isRepoCheckout()
  const grace = deps.supervisorGraceMs ?? SUPERVISOR_GRACE_MS

  return {
    async execute(payload: MicrovmExecPayload): Promise<MicrovmResult> {
      if (!binary) throw new Error(sandboxExecUnavailableMessage(devCheckout))
      // `timeout` is seconds and 0 means "no deadline", which the Rust side
      // honours deliberately. Mirroring it keeps a long build from being killed
      // by the supervisor when the policy said not to kill it.
      const policyTimeout = payload.command?.timeout ?? 0
      const deadline = policyTimeout > 0 ? policyTimeout * 1000 + grace : null
      const envelope = await runHelper(
        binary,
        ["--exec"],
        JSON.stringify({
          ...payload,
          command: {
            ...payload.command,
            // run_confined clears the environment. Keep executable discovery
            // without importing login profiles or provider credentials.
            env: {
              ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
              ...payload.command.env,
            },
          },
        }),
        spawnFn,
        deadline
      )
      if (envelope.ok !== true || !envelope.result) {
        throw new Error(formatSandboxError(envelope.error))
      }
      return envelope.result
    },

    async probe(): Promise<CodeSandboxStatus> {
      if (!binary) {
        return { confined: false, backend: "", detail: sandboxExecUnavailableMessage(devCheckout) }
      }
      try {
        const envelope = await runHelper(binary, ["--probe"], null, spawnFn, grace)
        return {
          confined: envelope.probe?.confined === true,
          backend: envelope.probe?.backend ?? "",
          detail: envelope.probe?.detail ?? "",
        }
      } catch (err) {
        // A probe that could not run is not evidence of confinement. It is the
        // fail-closed answer, carrying the reason so the operator can act.
        return { confined: false, backend: "", detail: describe(err) }
      }
    },
  }
}
