/**
 * The chat controller's single entry into Router + Fusion at dispatch
 * (ADR-0188 D36–D38).
 *
 * A send without a Router + Fusion stamp — every send while the switch is off —
 * returns untouched after one property check; nothing is loaded. A stamped send
 * gets its run created right before dispatch. A send that reuses cached options
 * (retry, loop continuation) is routed again first, because its old stamp names
 * a run that is already sealed.
 *
 * Outcomes the controller acts on:
 *  - `send`: dispatch these options (ledgered, or unledgered with a notice when
 *    Router + Fusion faulted — ordinary chat is never blocked by a fault);
 *  - `refused`: do not dispatch; show the refusal. A refusal is an answer, not a
 *    fault, and is never bypassed.
 */

import type { SendOptions } from "@cognia/agent-config-types"

import { breakerThresholdOf, type RouterFusionGateSettings } from "./feature-gate"
import { runOrdinaryWithFallback, type BypassNotice } from "./guard"
import { loadRouterFusionHost, type RouterFusionHost } from "./load-engine"

export type RouterFusionSendOutcome =
  { kind: "send"; options: SendOptions } | { kind: "refused"; code: string; reasons?: string[] }

export interface PrepareRouterFusionSendInput {
  sessionId: string
  options: SendOptions
  /** The options came from a cache (retry / continuation), not a fresh build. */
  reused: boolean
  workspaceId: string | null
  settings: RouterFusionGateSettings | null | undefined
  signal?: AbortSignal
  /** Test seam. */
  loadHost?: () => Promise<RouterFusionHost>
}

function unledgered(options: SendOptions, bypass: SendOptions["routerFusionBypass"]): SendOptions {
  const { ledger: _ledger, routerFusion: _stamp, routerFusionBypass: _previous, ...rest } = options
  return bypass ? { ...rest, routerFusionBypass: bypass } : rest
}

/**
 * Chat is ordinary traffic (D38): a fault in the fusion step sends the options
 * it was working on, unledgered, with the notice the message shows.
 */
function guardChatSend(
  settings: RouterFusionGateSettings | null | undefined,
  context: string,
  pending: () => SendOptions,
  fusion: () => Promise<RouterFusionSendOutcome>
): Promise<RouterFusionSendOutcome> {
  let notice: BypassNotice | null = null
  return runOrdinaryWithFallback<RouterFusionSendOutcome>({
    surface: "chat",
    threshold: breakerThresholdOf(settings),
    fusion,
    onBypass: (bypass) => {
      notice = bypass
      console.warn(`[router-fusion] ${context} sent on the original path`, bypass.fault)
    },
    original: async () => ({
      kind: "send",
      options: unledgered(
        pending(),
        notice ? { code: notice.fault.code, justTripped: notice.justTripped } : undefined
      ),
    }),
  })
}

export async function prepareRouterFusionSend(
  input: PrepareRouterFusionSendInput
): Promise<RouterFusionSendOutcome> {
  if (!input.options.routerFusion) return { kind: "send", options: input.options }
  let options = input.options
  return guardChatSend(
    input.settings,
    "chat turn",
    () => options,
    async () => {
      const host = await (input.loadHost ?? loadRouterFusionHost)()
      if (input.reused) {
        const resealed = await host.resealRouterFusionOptions({
          sessionId: input.sessionId,
          options,
          workspaceId: input.workspaceId,
        })
        if (resealed.kind === "refused") {
          return { kind: "refused", code: resealed.code, reasons: [...resealed.reasons] }
        }
        if (resealed.kind === "bypassed") return { kind: "send", options: resealed.options }
        options = resealed.options
      }
      const started = await host.startRouterFusionChatTurn({
        sessionId: input.sessionId,
        options,
        ...(input.signal ? { signal: input.signal } : {}),
      })
      if (started.kind === "started") return { kind: "send", options }
      return {
        kind: "refused",
        code: started.kind === "declined" ? "DECLINED_GRANT" : started.code,
      }
    }
  )
}

/** The most reroutes one ledgered chat turn may take, all before anything was shown (D5). */
export const MAX_LEDGERED_REROUTES = 2

export interface RerouteRouterFusionSendInput {
  sessionId: string
  /** The failed turn's options with the next candidate's provider and model swapped in. */
  options: SendOptions
  workspaceId: string | null
  settings: RouterFusionGateSettings | null | undefined
  /** Test seam. */
  loadHost?: () => Promise<RouterFusionHost>
}

/**
 * Route a routing-fallback retry of a ledgered turn as a new run (D5): the
 * next candidate passes the hard filters and gets its own reservation, or the
 * retry is refused. The failed turn's run was sealed when it ended. A fault
 * sends the retry on the original path with the notice, like any send.
 */
export async function rerouteRouterFusionSend(
  input: RerouteRouterFusionSendInput
): Promise<RouterFusionSendOutcome> {
  if (!input.options.routerFusion) return { kind: "send", options: input.options }
  return guardChatSend(
    input.settings,
    "chat reroute",
    () => input.options,
    async () => {
      const host = await (input.loadHost ?? loadRouterFusionHost)()
      const rerouted = await host.rerouteRouterFusionTurn({
        sessionId: input.sessionId,
        options: input.options,
        workspaceId: input.workspaceId,
      })
      if (rerouted.kind === "refused") return { kind: "refused", code: rerouted.code }
      return { kind: "send", options: rerouted.options }
    }
  )
}

/** The dispatch itself failed after the run was created: release it. Never throws. */
export async function abortRouterFusionSend(
  sessionId: string,
  options: SendOptions,
  reason: string,
  loadHost: () => Promise<RouterFusionHost> = loadRouterFusionHost
): Promise<void> {
  if (!options.routerFusion) return
  try {
    const host = await loadHost()
    await host.abortRouterFusionChatTurn(sessionId, reason)
  } catch (error) {
    console.warn("[router-fusion] could not release the run of a failed dispatch", error)
  }
}
