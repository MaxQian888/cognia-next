/**
 * The seam every renderer-side generation passes through (ADR-0188 D27, D36–D38).
 *
 * `buildRendererLlmClient` is where roughly twenty features get the client they
 * call a provider with directly, outside the sidecar: conversation titles,
 * timeline labels, the `/goal` judge, plan and goal decomposition, the eval
 * judge, agent-team auto-compose, workflow prompt nodes. Wrapping the client
 * there puts all of them on the ledger at one seam instead of twenty.
 *
 * With the switch off, `ledgerUtilityCalls` returns the very client it was
 * given after one property read — the feature's calls are byte-for-byte what
 * they were, and no Router + Fusion module is loaded. With it on, each call
 * becomes its own session-less utility run: reserved before the request leaves,
 * settled from that call's own usage when it comes back.
 *
 * Utilities are ordinary traffic (D38), so an infrastructure fault sends the
 * call out on the original path, unledgered, counts towards the breaker, and
 * raises the `routerFusionBypassed` notice (`bypass-diagnostic.ts`). A
 * refusal — no budget left, no route past the hard filters — is an answer and
 * is raised, never bypassed.
 *
 * The decorator lives here rather than behind the gate because it is pure: it
 * needs types, a refusal class and the `begin` callback the gate supplies. The
 * work `begin` does is loaded dynamically, behind the gate, and only then.
 */

import type { AppSettings } from "@cognia/agent-config-types"
import type { RawUsage, RoleCallErrorClass } from "@cognia/router-fusion"
import type { RouterFusionSurface } from "@cognia/router-fusion/settings/switches"
import type {
  LlmClient,
  LlmClientCallOptions,
  LlmUsageSnapshot,
  UsageDelta,
} from "@/lib/twin/distill/llm"

import { reportLedgerBypass } from "./bypass-diagnostic"
import { RouterFusionRefusalError } from "./faults"
import { breakerThresholdOf, routerFusionGate, type RouterFusionGateSettings } from "./feature-gate"
import { runOrdinaryWithFallback } from "./guard"
import { loadRouterFusionHost, type RouterFusionHost } from "./load-engine"

/** Where a utility run came from, for the run list and the governance catalog. */
export type UtilityRunOrigin = "utility" | "agent" | "workflow" | "chat"

export interface LedgeredUtilityBinding {
  surface: RouterFusionSurface
  origin: UtilityRunOrigin
  /** Stable id of the feature making the call, e.g. `conversation-title`. */
  featureId: string
  /** The app's provider id (not the SDK protocol): pricing and policy key off it. */
  providerId: string
  modelId: string
  workspaceId: string | null
}

export interface BeginLedgeredUtilityCallInput extends LedgeredUtilityBinding {
  prompt: string
  system: string | undefined
  maxOutputTokens: number | undefined
}

/** The reservation a granted call holds until it is settled. */
export interface UtilityCallHandleLike {
  readonly runId: string
  readonly maxOutputTokens: number
  succeeded(usage: RawUsage | null): Promise<void>
  failed(errorClass: RoleCallErrorClass, usage?: RawUsage | null): Promise<void>
  unknown(reason: string): Promise<void>
}

export type UtilityGrant =
  | { kind: "granted"; handle: UtilityCallHandleLike }
  | { kind: "refused"; code: string; reasons?: string[] }

/**
 * One call's own usage in the ledger's shape, or `null` when the provider
 * reported nothing — which is "unknown", not "free": the reservation stands as
 * the estimate.
 */
export function rawUsageOf(delta: UsageDelta | null | undefined): RawUsage | null {
  if (!delta) return null
  const { inputTokens: input, outputTokens: output } = delta
  const cacheRead = delta.cacheReadTokens
  const cacheWrite = delta.cacheCreationTokens
  if (input <= 0 && output <= 0 && cacheRead <= 0 && cacheWrite <= 0) return null
  return {
    inputTokens: Math.max(0, input),
    outputTokens: Math.max(0, output),
    ...(cacheRead > 0 ? { cacheReadTokens: cacheRead } : {}),
    ...(cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {}),
  }
}

/** The tokens one call added to a client's cumulative snapshot. */
export function usageDelta(
  before: LlmUsageSnapshot | undefined,
  after: LlmUsageSnapshot | undefined
): RawUsage | null {
  if (!after) return null
  // A provider that reported no usage leaves the snapshot where it was. That is
  // "unknown", not "free": the reservation stands as the estimate.
  return rawUsageOf({
    inputTokens: after.inputTokens - (before?.inputTokens ?? 0),
    outputTokens: after.outputTokens - (before?.outputTokens ?? 0),
    cacheReadTokens: (after.cacheReadTokens ?? 0) - (before?.cacheReadTokens ?? 0),
    cacheCreationTokens: (after.cacheCreationTokens ?? 0) - (before?.cacheCreationTokens ?? 0),
  })
}

/**
 * How a renderer-side provider failure is booked. The distinction that matters
 * is whether anything was sent: an aborted call had already left, so its bill is
 * unknowable and its money stays held.
 */
export function classifyUtilityFailure(error: unknown): RoleCallErrorClass {
  const name = error instanceof Error ? error.name : ""
  if (name === "AbortError" || name === "TimeoutError") return "cancelled"
  const carrier = error as { statusCode?: unknown; status?: unknown } | null
  const status =
    typeof carrier?.statusCode === "number"
      ? carrier.statusCode
      : typeof carrier?.status === "number"
        ? carrier.status
        : null
  if (status !== null) {
    if (status === 429) return "rate_limited"
    if (status === 401 || status === 403) return "auth"
    if (status >= 500) return "server_error"
    if (status >= 400) return "invalid_request"
  }
  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase()
  if (message.includes("fetch failed") || message.includes("econnrefused")) return "not_sent"
  return "server_error"
}

/** A settle that failed has already lost the race with the provider's bill: never throw it at the caller. */
async function bookOutcome(book: () => Promise<void>): Promise<void> {
  try {
    await book()
  } catch (error) {
    console.error("[router-fusion] a utility call could not be booked", error)
  }
}

export interface LedgeredClientDeps {
  /** Null means Router + Fusion bypassed this call after a fault: send it unledgered. */
  begin: (input: BeginLedgeredUtilityCallInput) => Promise<UtilityGrant | null>
}

/**
 * A one-at-a-time lock. `acquire()` resolves with the release once every
 * earlier holder has released.
 */
function serialLock(): () => Promise<() => void> {
  let tail: Promise<void> = Promise.resolve()
  return async () => {
    let release!: () => void
    const held = new Promise<void>((resolve) => {
      release = resolve
    })
    const previous = tail
    tail = previous.then(() => held)
    await previous
    return release
  }
}

const NO_LOCK = async () => () => {}

/**
 * Wrap a client so each of its calls is a ledgered utility run.
 *
 * Each call is settled with its OWN usage. A client that reports per-call usage
 * (`reportsCallUsage`, which `createLlmClient` does) is read through
 * `onUsage`, so any number of calls may run on it at once — the twin distiller
 * does exactly that. A client that keeps only a cumulative snapshot cannot say
 * which call spent what while two are in flight, so its calls run one at a time
 * and each is settled from the snapshot's movement across its own call. A
 * concurrent pair would otherwise both read the other's tokens and book them
 * twice.
 */
export function ledgeredLlmClient(
  inner: LlmClient,
  binding: LedgeredUtilityBinding,
  deps: LedgeredClientDeps
): LlmClient {
  const perCall = inner.reportsCallUsage === true
  const acquire = perCall ? NO_LOCK : serialLock()

  const start = (prompt: string, options: LlmClientCallOptions | undefined) =>
    deps.begin({
      ...binding,
      prompt,
      system: options?.system,
      maxOutputTokens: options?.maxTokens,
    })

  const refusal = (grant: Extract<UtilityGrant, { kind: "refused" }>) =>
    new RouterFusionRefusalError(
      grant.code,
      `Router + Fusion refused a ${binding.featureId} call: ${grant.code}`,
      { featureId: binding.featureId, ...(grant.reasons ? { reasons: grant.reasons } : {}) }
    )

  const snapshot = () => inner.getUsageSnapshot?.()

  /**
   * What one granted call reads its usage from: the per-call report, or the
   * snapshot's movement since it started (only sound under the lock).
   */
  const meter = (options: LlmClientCallOptions | undefined, handle: UtilityCallHandleLike) => {
    let reported: RawUsage | null = null
    const before = perCall ? undefined : snapshot()
    const callOptions: LlmClientCallOptions = {
      ...options,
      maxRetries: 0,
      maxTokens: options?.maxTokens ?? handle.maxOutputTokens,
      ...(perCall
        ? {
            onUsage: (delta: UsageDelta) => {
              reported = rawUsageOf(delta)
              options?.onUsage?.(delta)
            },
          }
        : {}),
    }
    return {
      callOptions,
      usage: (): RawUsage | null => (perCall ? reported : usageDelta(before, snapshot())),
    }
  }

  return {
    ...(inner.provider !== undefined ? { provider: inner.provider } : {}),
    ...(inner.model !== undefined ? { model: inner.model } : {}),
    ...(perCall ? { reportsCallUsage: true } : {}),
    ...(inner.getUsageSnapshot ? { getUsageSnapshot: () => inner.getUsageSnapshot!() } : {}),

    async complete(prompt, options) {
      // Reserve under the lock too, so a queued call's reservation is taken
      // just before it is sent rather than while it waits its turn.
      const release = await acquire()
      try {
        const grant = await start(prompt, options)
        if (grant?.kind === "refused") throw refusal(grant)
        // Bypassed: sent as the caller asked, but still inside the lock, so an
        // unledgered call cannot move the snapshot under a ledgered one.
        if (!grant) return await inner.complete(prompt, options)
        const { handle } = grant
        const metered = meter(options, handle)
        let text: string
        try {
          text = await inner.complete(prompt, metered.callOptions)
        } catch (error) {
          const errorClass = classifyUtilityFailure(error)
          await bookOutcome(() =>
            errorClass === "cancelled"
              ? handle.unknown("aborted_before_answer")
              : handle.failed(errorClass, metered.usage())
          )
          throw error
        }
        await bookOutcome(() => handle.succeeded(metered.usage()))
        return text
      } finally {
        release()
      }
    },

    ...(inner.stream
      ? {
          async *stream(prompt: string, options?: LlmClientCallOptions) {
            const streamInner = inner.stream!
            const release = await acquire()
            try {
              const grant = await start(prompt, options)
              if (grant?.kind === "refused") throw refusal(grant)
              if (!grant) {
                yield* streamInner(prompt, options)
                return
              }
              const { handle } = grant
              const metered = meter(options, handle)
              let settled = false
              try {
                yield* streamInner(prompt, metered.callOptions)
                settled = true
                await bookOutcome(() => handle.succeeded(metered.usage()))
              } catch (error) {
                settled = true
                const errorClass = classifyUtilityFailure(error)
                // A stream that broke after it started had already been sent, so
                // its bill is unknowable; only a connect failure is provably unsent.
                await bookOutcome(() =>
                  errorClass === "not_sent"
                    ? handle.failed(errorClass, null)
                    : handle.unknown(`stream_${errorClass}`)
                )
                throw error
              } finally {
                // The consumer stopped reading before the stream ended: the
                // request was sent and its bill never arrived, so the money
                // stays held rather than the reservation being left open.
                if (!settled) await bookOutcome(() => handle.unknown("stream_abandoned"))
              }
            } finally {
              release()
            }
          },
        }
      : {}),
  }
}

export interface LedgerUtilityCallsInput {
  binding: LedgeredUtilityBinding
  settings: RouterFusionGateSettings | null | undefined
  /** Test seam. */
  loadHost?: () => Promise<RouterFusionHost>
}

/**
 * The call sites' one entry point. Off — which is every user by default — this
 * returns the client it was handed, untouched.
 */
export function ledgerUtilityCalls(inner: LlmClient, input: LedgerUtilityCallsInput): LlmClient {
  if (routerFusionGate(input.settings, input.binding.surface) !== "on") return inner
  const load = input.loadHost ?? loadRouterFusionHost
  return ledgeredLlmClient(inner, input.binding, {
    begin: (call) =>
      runOrdinaryWithFallback<UtilityGrant | null>({
        surface: input.binding.surface,
        threshold: breakerThresholdOf(input.settings),
        fusion: async () =>
          (await load()).beginLedgeredUtilityCall({
            ...call,
            // The same settings this gate just read, so the host does not
            // re-read them from a store a headless brain never loads.
            ...(input.settings ? { appSettings: input.settings as AppSettings } : {}),
          }),
        // Utilities have no message to badge: the notice is a diagnostic
        // (deduplicated per surface), and the breaker has already counted it.
        onBypass: (notice) =>
          reportLedgerBypass({
            surface: notice.surface,
            featureId: call.featureId,
            fault: notice.fault,
          }),
        // Bypassed: the feature's call still happens, it is simply not booked.
        original: async () => null,
      }),
  })
}
