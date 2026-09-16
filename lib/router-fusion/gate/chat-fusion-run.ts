/**
 * The chat controller's entry into a cascade or panel turn (ADR-0188 B3, D38).
 *
 * A send reaches this only when the send pipeline stamped it with
 * `SendOptions.routerFusionRun`, which it does only while the chat surface is
 * on. A fusion turn is work the person asked Router + Fusion for — explicitly,
 * or through a rule row they approved — so a fault is surfaced as
 * `RouterFusionUnavailableError` and counted, never answered by the ordinary
 * path instead. A refusal (a budget, a busy session) is an answer, not a fault.
 */

import type {
  AppSettings,
  RouterFusionRunStamp,
  RouterFusionRunSummary,
} from "@cognia/agent-config-types"

import { recordFusionFault } from "./breaker"
import { RouterFusionRefusalError, toInfrastructureFault } from "./faults"
import { breakerThresholdOf, routerFusionGate, type RouterFusionGateSettings } from "./feature-gate"
import { runExplicitFusion, trippedSurfaceError } from "./guard"
import { loadRouterFusionHost, type RouterFusionHost } from "./load-engine"

export type RouterFusionChatRunOutcome = Awaited<
  ReturnType<RouterFusionHost["startChatFusionTurn"]>
>

export interface RunRouterFusionChatTurnInput {
  sessionId: string
  stamp: RouterFusionRunStamp
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>
  workspaceRoot: string | null
  settings: RouterFusionGateSettings | null | undefined
  onProgress?: (summary: RouterFusionRunSummary) => void
  signal?: AbortSignal
  /** Test seam. */
  loadHost?: () => Promise<RouterFusionHost>
}

/**
 * Fusion turns in flight per session in this window. Counted: a stopped turn
 * still winding down must not clear the mark of the turn sent after it.
 */
const running = new Map<string, number>()

export function routerFusionChatRunActive(sessionId: string): boolean {
  return (running.get(sessionId) ?? 0) > 0
}

/**
 * Create and execute the turn's run. Resolves with the run's outcome; throws
 * `RouterFusionUnavailableError` on an infrastructure fault or when the chat
 * surface is off or paused.
 */
export async function runRouterFusionChatTurn(
  input: RunRouterFusionChatTurnInput
): Promise<RouterFusionChatRunOutcome> {
  const gate = routerFusionGate(input.settings, "chat")
  if (gate === "tripped") throw trippedSurfaceError("chat")
  if (gate === "off") {
    // The switch went off between routing and dispatch: explicit work does not
    // quietly become an ordinary turn.
    throw new RouterFusionRefusalError(
      "ROUTER_FUSION_DISABLED",
      "Router + Fusion is switched off for chat."
    )
  }
  running.set(input.sessionId, (running.get(input.sessionId) ?? 0) + 1)
  try {
    return await runExplicitFusion({
      surface: "chat",
      threshold: breakerThresholdOf(input.settings),
      fusion: async () => {
        const host = await (input.loadHost ?? loadRouterFusionHost)()
        return host.startChatFusionTurn({
          sessionId: input.sessionId,
          stamp: input.stamp,
          messages: input.messages,
          workspaceRoot: input.workspaceRoot,
          // Every caller hands the gate the full account settings; the gate
          // type only names the part it reads.
          appSettings: input.settings as AppSettings,
          ...(input.onProgress ? { onProgress: input.onProgress } : {}),
          ...(input.signal ? { signal: input.signal } : {}),
        })
      },
    })
  } finally {
    const left = (running.get(input.sessionId) ?? 1) - 1
    if (left > 0) running.set(input.sessionId, left)
    else running.delete(input.sessionId)
  }
}

/** The person stopped the turn. A no-op, without loading anything, for every other session. */
export async function cancelRouterFusionChatRun(
  sessionId: string,
  io: {
    loadHost?: () => Promise<RouterFusionHost>
    settings?: RouterFusionGateSettings | null
  } = {}
): Promise<void> {
  if (!routerFusionChatRunActive(sessionId)) return
  try {
    const host = await (io.loadHost ?? loadRouterFusionHost)()
    await host.cancelChatFusionTurn(sessionId)
  } catch (error) {
    const fault = toInfrastructureFault(error)
    recordFusionFault(
      "chat",
      fault?.code ?? "internal",
      breakerThresholdOf(io.settings),
      Date.now()
    )
    console.warn("[router-fusion] chat fusion turn could not be cancelled", error)
  }
}

export function __resetRouterFusionChatRunsForTesting(): void {
  running.clear()
}
