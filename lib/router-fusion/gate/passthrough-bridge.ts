/**
 * Where the gateway's passthrough reserve/settle lands in the brain (ADR-0188 D13, B2).
 *
 * Sibling of `run-api-bridge.ts`, deliberately separate, because the two lanes
 * answer a failure in OPPOSITE ways (D38):
 *
 *  - `/v1/runs` is work the caller explicitly asked Router + Fusion to do, so a
 *    fault fails the request rather than quietly doing something else;
 *  - a passthrough request is ORDINARY traffic the caller would have got
 *    anyway. A fault must never cost them their answer, so this module reports
 *    `bypassed` and the gateway proxies unledgered with `x-cognia-ledger:
 *    bypassed`. The fault still counts, and a surface that keeps failing trips
 *    its breaker and stops being asked.
 *
 * A refusal — the budget, a call limit, a hard filter — is NOT a fault and is
 * never bypassed: it comes back as a refusal the gateway turns into a real
 * status, because spending money the user said no to is the failure this whole
 * subsystem exists to prevent.
 */

import type { AppSettings } from "@cognia/agent-config-types"
import type { RoleCallErrorClass } from "@cognia/router-fusion"

import { breakerThresholdOf, routerFusionGate, type RouterFusionGateSettings } from "./feature-gate"
import { runOrdinaryWithFallback } from "./guard"
import { loadRouterFusionHost, type RouterFusionHost } from "./load-engine"

/** The commands Rust sends, mirroring `passthrough_ledger::command` in the gateway crate. */
export const ROUTER_FUSION_PASSTHROUGH_COMMANDS = [
  "router_fusion_passthrough_reserve",
  "router_fusion_passthrough_settle",
] as const
export type RouterFusionPassthroughCommand = (typeof ROUTER_FUSION_PASSTHROUGH_COMMANDS)[number]

export function isRouterFusionPassthroughCommand(
  command: string
): command is RouterFusionPassthroughCommand {
  return (ROUTER_FUSION_PASSTHROUGH_COMMANDS as readonly string[]).includes(command)
}

export type PassthroughOutcome =
  /** Reserved or settled. The gateway carries `runId` back in `x-cognia-run-id`. */
  | { status: "ledgered"; runId?: string; attemptId?: string; sealed?: boolean }
  /** The ledger said no. A real answer with a real reason. */
  | { status: "refused"; code: string; reasons?: string[] }
  /** The ledger could not answer. The request proceeds unledgered. */
  | { status: "bypassed"; code: string }

const SURFACE = "gatewayPassthroughLedger" as const

export interface RouterFusionPassthroughDeps {
  settings: RouterFusionGateSettings | null | undefined
  /** Test seam. */
  loadHost?: () => Promise<RouterFusionHost>
}

/**
 * Run one bridged passthrough command. Never throws and never leaves the
 * gateway without an answer: every path ends in one of the three outcomes.
 */
export async function dispatchRouterFusionPassthroughCommand(
  command: RouterFusionPassthroughCommand,
  payload: Record<string, unknown>,
  deps: RouterFusionPassthroughDeps
): Promise<PassthroughOutcome> {
  const gate = routerFusionGate(deps.settings, SURFACE)
  // Off and tripped are both "do not ask the ledger", and both let the request
  // through — the caller never asked for Router + Fusion, they asked for a
  // proxy. The codes differ so the gateway's header says which it was.
  if (gate === "off") return { status: "bypassed", code: "surface_off" }
  if (gate === "tripped") return { status: "bypassed", code: "breaker_tripped" }

  const load = deps.loadHost ?? loadRouterFusionHost
  return runOrdinaryWithFallback<PassthroughOutcome>({
    surface: SURFACE,
    threshold: breakerThresholdOf(deps.settings),
    fusion: async () => {
      const host = await load()
      if (command === "router_fusion_passthrough_reserve") {
        const reserved = await host.reservePassthroughCall(
          reserveInputOf(payload),
          // The full account settings, as every caller passes them.
          deps.settings as AppSettings | null | undefined
        )
        return reserved.kind === "reserved"
          ? { status: "ledgered", runId: reserved.runId, attemptId: reserved.attemptId }
          : {
              status: "refused",
              code: reserved.code,
              ...(reserved.reasons ? { reasons: reserved.reasons } : {}),
            }
      }
      const settled = await host.settlePassthroughCall(settleInputOf(payload))
      return { status: "ledgered", sealed: settled.sealed }
    },
    onBypass: (notice) => {
      console.warn(
        `[router-fusion] gateway passthrough went unledgered: ${notice.fault.code}`,
        notice.fault.message
      )
    },
    original: async () => ({ status: "bypassed", code: "ledger_unavailable" }),
  })
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback
}

function num(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}

function reserveInputOf(payload: Record<string, unknown>) {
  const maxOutputTokens =
    typeof payload.maxOutputTokens === "number" ? payload.maxOutputTokens : undefined
  return {
    requestId: str(payload.requestId),
    attempt: num(payload.attempt),
    providerId: str(payload.providerId),
    modelId: str(payload.modelId),
    requestedModel: str(payload.requestedModel),
    keyId: typeof payload.keyId === "string" ? payload.keyId : null,
    keyName: str(payload.keyName),
    estimatedInputTokens: num(payload.estimatedInputTokens),
    ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
  }
}

/**
 * Usage as the gateway can see it: the token counts it already sniffs out of
 * the answer for its own accounting. Anything the upstream did not report stays
 * absent rather than becoming a zero, because a zero is a claim about the bill.
 */
/** The failure classes the gateway sends; anything else is dropped, not trusted. */
const GATEWAY_ERROR_CLASSES: ReadonlySet<string> = new Set<RoleCallErrorClass>([
  "not_sent",
  "rate_limited",
  "server_error",
  "auth",
  "invalid_request",
])

function outcomeOf(value: unknown): "succeeded" | "failed" | "unknown" {
  // An outcome this build does not know is treated as the one that holds the
  // money: guessing "succeeded" would release a reservation for a call whose
  // bill nobody read.
  return value === "succeeded" || value === "failed" ? value : "unknown"
}

function settleInputOf(payload: Record<string, unknown>) {
  const usageIn = (payload.usage ?? null) as Record<string, unknown> | null
  const usage =
    usageIn && (typeof usageIn.inputTokens === "number" || typeof usageIn.outputTokens === "number")
      ? {
          inputTokens: num(usageIn.inputTokens),
          outputTokens: num(usageIn.outputTokens),
          ...(typeof usageIn.cacheReadTokens === "number"
            ? { cacheReadTokens: usageIn.cacheReadTokens }
            : {}),
          ...(typeof usageIn.cacheWriteTokens === "number"
            ? { cacheWriteTokens: usageIn.cacheWriteTokens }
            : {}),
        }
      : null
  const errorClass =
    typeof payload.errorClass === "string" && GATEWAY_ERROR_CLASSES.has(payload.errorClass)
      ? (payload.errorClass as RoleCallErrorClass)
      : undefined
  return {
    runId: str(payload.runId),
    attemptId: str(payload.attemptId),
    outcome: outcomeOf(payload.outcome),
    usage,
    ...(errorClass ? { errorClass } : {}),
    ...(typeof payload.reason === "string" ? { reason: payload.reason } : {}),
    final: payload.final === true,
  }
}
