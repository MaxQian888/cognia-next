/**
 * The host seam for a direct AI SDK generation (ADR-0188 D27, WP-L1).
 *
 * Most renderer-side generations go through an `LlmClient`, so one decorator —
 * `ledgerUtilityCalls` in `lib/router-fusion/gate/utility-ledger.ts` — puts
 * them all on the CallLedger at a single seam. A dozen call sites do not: they
 * hold an AI SDK `LanguageModel` and call `generateText` / `streamText` /
 * `generateObject` on it directly, because they need the full SDK result
 * (tool calls, a structured object, a live stream of parts), which an
 * `LlmClient` (text in, text out) cannot carry.
 *
 * This module is the ledger seam for those. It exposes the reservation itself
 * rather than a wrapper, because the shapes differ too much for one wrapper:
 *
 * ```ts
 * const lease = await beginLedgeredGeneration({ binding, prompt, system })
 * try {
 *   const result = await generateText({ ...args, ...lease?.options })
 *   await lease?.succeeded(usageOfResult(result))
 * } catch (error) {
 *   await lease?.failed(error)
 *   throw error
 * }
 * ```
 *
 * The contract, matching `ledgerUtilityCalls`:
 *
 *  - **Off, or a tripped surface** — `beginLedgeredGeneration` answers `null`
 *    after one property read, `lease?.options` spreads to nothing, and the call
 *    is byte-for-byte what it was (D37). No Router + Fusion module is loaded.
 *  - **On** — the call is reserved before it leaves (a session-less utility
 *    run), sent with the reservation's output bound and `maxRetries: 0` so the
 *    SDK cannot spend money the ledger never reserved, and settled from the
 *    usage the provider reported.
 *  - **An infrastructure fault** in the ledger answers `null` too: the call
 *    goes out on the original path, unledgered, with the "not ledgered" notice,
 *    and the breaker counts it (D38). That is `runOrdinaryWithFallback`.
 *  - **A refusal** (no budget, no route past the hard filters) is an answer,
 *    not a fault: it is raised as `RouterFusionRefusalError` and the call is
 *    not made.
 *
 * `lib/ai/ledgered-generation-seam.ts` is the sibling for the pure packages,
 * which cannot hold an AI SDK result at all and take a `send` seam instead.
 */

import type { AppSettings } from "@cognia/agent-config-types"
import type { RawUsage, RoleCallErrorClass } from "@cognia/router-fusion"

import { RouterFusionRefusalError } from "@/lib/router-fusion/gate/faults"
import {
  breakerThresholdOf,
  routerFusionGate,
  type RouterFusionGateSettings,
} from "@/lib/router-fusion/gate/feature-gate"
import { runOrdinaryWithFallback } from "@/lib/router-fusion/gate/guard"
import { loadRouterFusionHost, type RouterFusionHost } from "@/lib/router-fusion/gate/load-engine"
import {
  classifyUtilityFailure,
  type LedgeredUtilityBinding,
  type UtilityCallHandleLike,
  type UtilityGrant,
} from "@/lib/router-fusion/gate/utility-ledger"
import { readUsageDelta } from "@/lib/twin/distill/llm"

export type { LedgeredUtilityBinding } from "@/lib/router-fusion/gate/utility-ledger"

/**
 * The options fragment a ledgered call must carry, spreadable into
 * `generateText` / `streamText` / `generateObject` arguments.
 *
 * `maxRetries: 0` is not a tuning choice: an SDK retry is a second paid request
 * the ledger never reserved and never sees, so a ledgered call turns them off
 * and lets the ledger's own attempts be the retries.
 */
export interface LedgeredGenerationOptions {
  readonly maxRetries: 0
  /** The output bound the reservation was priced for (or the caller's own, when tighter). */
  readonly maxOutputTokens: number
}

/** A granted reservation, held until the call is settled. */
export interface LedgeredGenerationLease {
  readonly runId: string
  readonly options: LedgeredGenerationOptions
  /** The provider answered. `null` usage means it reported none; the estimate stands. */
  succeeded(usage: RawUsage | null): Promise<void>
  /** The call failed. An abort is booked as `unknown`: it had already left. */
  failed(error: unknown, usage?: RawUsage | null): Promise<void>
  /** Sent, no readable answer (a broken stream, a timeout): the money stays held. */
  unknown(reason: string): Promise<void>
}

export interface BeginLedgeredGenerationInput {
  binding: LedgeredUtilityBinding
  /** Everything the reservation is estimated from. */
  prompt: string
  system?: string | undefined
  /** The caller's own output cap, when it has one. */
  maxOutputTokens?: number | undefined
  /**
   * The settings the gate reads. Omit to read the current host's — the
   * hydrated settings store when there is one, else the account's Dexie row.
   */
  settings?: RouterFusionGateSettings | null | undefined
  /** Test seams. */
  loadHost?: () => Promise<RouterFusionHost>
  readSettings?: () => Promise<RouterFusionGateSettings | null>
}

/**
 * The settings a gate check reads on this host. An unreadable switch is read as
 * off — it must never be the thing that turns Router + Fusion on.
 */
async function gateSettings(input: BeginLedgeredGenerationInput) {
  if (input.settings !== undefined) return input.settings
  try {
    if (input.readSettings) return await input.readSettings()
    const { currentRouterFusionGateSettings } =
      await import("@/lib/router-fusion/gate/current-settings")
    return await currentRouterFusionGateSettings()
  } catch (error) {
    console.warn("[router-fusion] settings unreadable; treating the surface as off", error)
    return null
  }
}

/** A settle that failed has already lost the race with the provider's bill: never throw it at the caller. */
async function bookOutcome(book: () => Promise<void>): Promise<void> {
  try {
    await book()
  } catch (error) {
    console.error("[router-fusion] a ledgered generation could not be booked", error)
  }
}

function leaseOf(
  handle: UtilityCallHandleLike,
  callerCap: number | undefined
): LedgeredGenerationLease {
  return {
    runId: handle.runId,
    options: {
      maxRetries: 0,
      maxOutputTokens: callerCap ?? handle.maxOutputTokens,
    },
    succeeded: (usage) => bookOutcome(() => handle.succeeded(usage)),
    failed: (error, usage) => {
      const errorClass: RoleCallErrorClass = classifyUtilityFailure(error)
      return bookOutcome(() =>
        // An aborted call had already left, so its bill is unknowable.
        errorClass === "cancelled"
          ? handle.unknown("aborted_before_answer")
          : handle.failed(errorClass, usage ?? null)
      )
    },
    unknown: (reason) => bookOutcome(() => handle.unknown(reason)),
  }
}

/**
 * Reserve one direct AI SDK generation, or answer `null` when it is not
 * ledgered — the surface is off, its breaker is open, or the ledger itself
 * faulted and the call falls back to the original path (D38).
 *
 * @throws RouterFusionRefusalError when the ledger refuses the call. A refusal
 * is an answer: the call must not be made.
 */
export async function beginLedgeredGeneration(
  input: BeginLedgeredGenerationInput
): Promise<LedgeredGenerationLease | null> {
  const settings = await gateSettings(input)
  if (routerFusionGate(settings, input.binding.surface) !== "on") return null
  const load = input.loadHost ?? loadRouterFusionHost

  const grant = await runOrdinaryWithFallback<UtilityGrant | null>({
    surface: input.binding.surface,
    threshold: breakerThresholdOf(settings),
    fusion: async () =>
      (await load()).beginLedgeredUtilityCall({
        ...input.binding,
        prompt: input.prompt,
        system: input.system,
        maxOutputTokens: input.maxOutputTokens,
        // The settings the gate just read, so the host does not re-read them
        // from a store a headless brain never loads.
        ...(settings ? { appSettings: settings as AppSettings } : {}),
      }),
    onBypass: (notice) => {
      console.warn(
        `[router-fusion] ${input.binding.featureId} called on the original path, unledgered`,
        notice.fault
      )
    },
    // Bypassed: the call still happens, it is simply not booked.
    original: async () => null,
  })

  if (!grant) return null
  if (grant.kind === "refused") {
    throw new RouterFusionRefusalError(
      grant.code,
      `Router + Fusion refused a ${input.binding.featureId} call: ${grant.code}`,
      {
        featureId: input.binding.featureId,
        ...(grant.reasons ? { reasons: grant.reasons } : {}),
      }
    )
  }
  return leaseOf(grant.handle, input.maxOutputTokens)
}

/**
 * One AI SDK result's usage in the ledger's shape, or `null` when the provider
 * reported nothing — which is "unknown", not "free": the reservation stands as
 * the estimate.
 *
 * `readUsageDelta` is the repo's one normalizer for an AI SDK usage object, so
 * a ledgered direct call and a ledgered `LlmClient` call bill one provider bill
 * the same way.
 */
export function usageOfResult(usage: unknown, providerMetadata?: unknown): RawUsage | null {
  const delta = readUsageDelta(
    usage as Record<string, unknown> | undefined,
    providerMetadata as Record<string, unknown> | undefined
  )
  if (
    delta.inputTokens <= 0 &&
    delta.outputTokens <= 0 &&
    delta.cacheReadTokens <= 0 &&
    delta.cacheCreationTokens <= 0
  ) {
    return null
  }
  return {
    inputTokens: Math.max(0, delta.inputTokens),
    outputTokens: Math.max(0, delta.outputTokens),
    ...(delta.cacheReadTokens > 0 ? { cacheReadTokens: delta.cacheReadTokens } : {}),
    ...(delta.cacheCreationTokens > 0 ? { cacheWriteTokens: delta.cacheCreationTokens } : {}),
  }
}

export interface LedgeredGenerationRun<T> extends BeginLedgeredGenerationInput {
  /** The generation itself. `options` is `undefined` when the call is not ledgered. */
  run: (options: LedgeredGenerationOptions | undefined) => Promise<T>
  /** The usage to settle with, read from the awaited result. */
  usageOf: (result: T) => RawUsage | null
}

/**
 * {@link beginLedgeredGeneration} around one awaited generation — the shape
 * almost every non-streaming call site wants.
 */
export async function withLedgeredGeneration<T>(input: LedgeredGenerationRun<T>): Promise<T> {
  const lease = await beginLedgeredGeneration(input)
  if (!lease) return input.run(undefined)
  let result: T
  try {
    result = await input.run(lease.options)
  } catch (error) {
    await lease.failed(error)
    throw error
  }
  await lease.succeeded(input.usageOf(result))
  return result
}
