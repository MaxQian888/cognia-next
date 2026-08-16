/**
 * Resource limits for the Code tool presentation (ADR-0117, Phase 4).
 *
 * Every limit is a hard ceiling enforced by the runner, not a hint to the
 * model. They live in one module because the sandbox supervisor, the SDK
 * bridge, and the UI that explains a limit hit all have to agree on the exact
 * number — a supervisor that killed at 30s while the UI promised 60s would read
 * as a bug rather than as policy.
 *
 * The values are the first-release figures from the ADR. They are deliberately
 * conservative: a script that needs more than 64 tool calls is doing a survey
 * that belongs in a real turn, not inside one `run_code` call.
 *
 * The numbers live in `./limits.json` rather than here because the sandbox
 * supervisor is a sidecar `.mjs` module that cannot import TypeScript. One JSON
 * both sides read is the only arrangement where the ceiling the supervisor
 * enforces and the ceiling this module reports cannot drift apart.
 */

import limitsData from "./limits.json"

export interface CodeModeLimits {
  /** Largest program the model may submit, in bytes of UTF-8 source. */
  maxSourceBytes: number
  /** Wall-clock ceiling for one `run_code` call. */
  wallTimeMs: number
  /** Total SDK calls one program may make. */
  maxToolCalls: number
  /** SDK calls that may be in flight at once. */
  maxConcurrency: number
  /** Combined size of everything the program returns. */
  maxResultBytes: number
  /** Heap ceiling for the sandbox child process. */
  maxMemoryBytes: number
}

export const CODE_MODE_LIMITS: Readonly<CodeModeLimits> = Object.freeze(
  limitsData as CodeModeLimits
)

/** Why a `run_code` call was stopped. Machine-stable; rendered via i18n. */
export type CodeLimitKind =
  "source-too-large" | "wall-time" | "tool-calls" | "result-too-large" | "memory"

export interface CodeLimitExceeded {
  kind: CodeLimitKind
  /** The ceiling that was hit. */
  limit: number
  /** What was actually observed, when the runner could measure it. */
  observed?: number
}

/**
 * Pre-flight the source size.
 *
 * Checked before the sandbox is even spawned: rejecting a 4 MiB program costs
 * nothing here and costs a process spawn plus a compile if it is deferred.
 */
export function checkSourceSize(
  source: string,
  limits: CodeModeLimits = CODE_MODE_LIMITS
): CodeLimitExceeded | null {
  const bytes = byteLength(source)
  if (bytes <= limits.maxSourceBytes) return null
  return { kind: "source-too-large", limit: limits.maxSourceBytes, observed: bytes }
}

export function checkResultSize(
  serialized: string,
  limits: CodeModeLimits = CODE_MODE_LIMITS
): CodeLimitExceeded | null {
  const bytes = byteLength(serialized)
  if (bytes <= limits.maxResultBytes) return null
  return { kind: "result-too-large", limit: limits.maxResultBytes, observed: bytes }
}

/**
 * UTF-8 byte length without assuming a Node `Buffer`.
 *
 * `lib/` is compiled into a static export that also runs in the browser and on
 * mobile, so `Buffer.byteLength` is not reachable here — and `source.length`
 * would undercount every non-ASCII program, letting an oversized script through
 * the pre-flight the sandbox is relying on.
 */
export function byteLength(value: string): number {
  return new TextEncoder().encode(value).length
}

/**
 * Tracks the two limits that can only be known while the program runs.
 *
 * Kept as a small class rather than counters threaded through the bridge so
 * that "have we run out of budget?" has exactly one answer, and so the
 * concurrency gate cannot be bypassed by a caller that forgot to decrement.
 */
export class CodeCallBudget {
  private used = 0
  private inFlight = 0

  constructor(private readonly limits: CodeModeLimits = CODE_MODE_LIMITS) {}

  get callsUsed(): number {
    return this.used
  }

  get callsRemaining(): number {
    return Math.max(0, this.limits.maxToolCalls - this.used)
  }

  get concurrencyAvailable(): number {
    return Math.max(0, this.limits.maxConcurrency - this.inFlight)
  }

  /**
   * Reserve one call slot.
   *
   * Returns a limit violation when the total budget is spent. Concurrency is
   * NOT a violation — it is backpressure — so an over-concurrent caller is told
   * to wait rather than being failed.
   */
  tryAcquire(): { ok: true } | { ok: false; exceeded?: CodeLimitExceeded; retry?: true } {
    if (this.used >= this.limits.maxToolCalls) {
      return {
        ok: false,
        exceeded: {
          kind: "tool-calls",
          limit: this.limits.maxToolCalls,
          observed: this.used + 1,
        },
      }
    }
    if (this.inFlight >= this.limits.maxConcurrency) {
      return { ok: false, retry: true }
    }
    this.used += 1
    this.inFlight += 1
    return { ok: true }
  }

  /** Release a slot acquired by `tryAcquire`. Never lowers the spent total. */
  release(): void {
    this.inFlight = Math.max(0, this.inFlight - 1)
  }
}
