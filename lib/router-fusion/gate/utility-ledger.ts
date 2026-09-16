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
 * settled from the client's own usage snapshot when it comes back.
 *
 * Utilities are ordinary traffic (D38), so an infrastructure fault sends the
 * call out on the original path, unledgered, and counts towards the breaker. A
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
import type { LlmClient, LlmClientCallOptions, LlmUsageSnapshot } from "@/lib/twin/distill/llm"

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

/** The tokens one call added to a client's cumulative snapshot. */
export function usageDelta(
  before: LlmUsageSnapshot | undefined,
  after: LlmUsageSnapshot | undefined
): RawUsage | null {
  if (!after) return null
  const input = after.inputTokens - (before?.inputTokens ?? 0)
  const output = after.outputTokens - (before?.outputTokens ?? 0)
  const cacheRead = (after.cacheReadTokens ?? 0) - (before?.cacheReadTokens ?? 0)
  const cacheWrite = (after.cacheCreationTokens ?? 0) - (before?.cacheCreationTokens ?? 0)
  // A provider that reported no usage leaves the snapshot where it was. That is
  // "unknown", not "free": the reservation stands as the estimate.
  if (input <= 0 && output <= 0 && cacheRead <= 0 && cacheWrite <= 0) return null
  return {
    inputTokens: Math.max(0, input),
    outputTokens: Math.max(0, output),
    ...(cacheRead > 0 ? { cacheReadTokens: cacheRead } : {}),
    ...(cacheWrite > 0 ? { cacheWriteTokens: cacheWrite } : {}),
  }
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

/** Wrap a client so each of its calls is a ledgered utility run. */
export function ledgeredLlmClient(
  inner: LlmClient,
  binding: LedgeredUtilityBinding,
  deps: LedgeredClientDeps
): LlmClient {
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

  const ledgered = (
    options: LlmClientCallOptions | undefined,
    handle: UtilityCallHandleLike
  ): LlmClientCallOptions => ({
    ...options,
    maxRetries: 0,
    maxTokens: options?.maxTokens ?? handle.maxOutputTokens,
  })

  const snapshot = () => inner.getUsageSnapshot?.()

  return {
    ...(inner.provider !== undefined ? { provider: inner.provider } : {}),
    ...(inner.model !== undefined ? { model: inner.model } : {}),
    ...(inner.getUsageSnapshot ? { getUsageSnapshot: () => inner.getUsageSnapshot!() } : {}),

    async complete(prompt, options) {
      const grant = await start(prompt, options)
      if (!grant) return inner.complete(prompt, options)
      if (grant.kind === "refused") throw refusal(grant)
      const { handle } = grant
      const before = snapshot()
      let text: string
      try {
        text = await inner.complete(prompt, ledgered(options, handle))
      } catch (error) {
        const errorClass = classifyUtilityFailure(error)
        await bookOutcome(() =>
          errorClass === "cancelled"
            ? handle.unknown("aborted_before_answer")
            : handle.failed(errorClass, usageDelta(before, snapshot()))
        )
        throw error
      }
      await bookOutcome(() => handle.succeeded(usageDelta(before, snapshot())))
      return text
    },

    ...(inner.stream
      ? {
          async *stream(prompt: string, options?: LlmClientCallOptions) {
            const streamInner = inner.stream!
            const grant = await start(prompt, options)
            if (!grant) {
              yield* streamInner(prompt, options)
              return
            }
            if (grant.kind === "refused") throw refusal(grant)
            const { handle } = grant
            const before = snapshot()
            try {
              yield* streamInner(prompt, ledgered(options, handle))
            } catch (error) {
              const errorClass = classifyUtilityFailure(error)
              // A stream that broke after it started had already been sent, so
              // its bill is unknowable; only a connect failure is provably unsent.
              await bookOutcome(() =>
                errorClass === "not_sent"
                  ? handle.failed(errorClass, null)
                  : handle.unknown(`stream_${errorClass}`)
              )
              throw error
            }
            await bookOutcome(() => handle.succeeded(usageDelta(before, snapshot())))
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
        onBypass: (notice) => {
          console.warn(
            `[router-fusion] ${call.featureId} called on the original path, unledgered`,
            notice.fault
          )
        },
        // Bypassed: the feature's call still happens, it is simply not booked.
        original: async () => null,
      }),
  })
}
