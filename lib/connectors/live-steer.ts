import type { NormalizedInboundEvent } from "@/types/connectors/event"
import type { LiveSteerHandler, LiveSteerResult } from "./bus"

export interface ActiveConnectorRun {
  conversationKey: string
  sessionId: string
  executionRunId: string
  provider: string
}

export interface ConnectorLiveSteerCoordinator {
  activate(run: ActiveConnectorRun): () => void
  handle: LiveSteerHandler
}

export interface ConnectorLiveSteerDependencies {
  admit(event: NormalizedInboundEvent): Promise<boolean>
  steer(sessionId: string, event: NormalizedInboundEvent): Promise<{ accepted: true }>
  storeInbound(event: NormalizedInboundEvent, sessionId: string): Promise<unknown>
}

/**
 * Coordinate live input with the durable connector lane. An inbound message is
 * stored with its real sender before the sidecar acknowledgement can complete;
 * any missing acknowledgement returns `accepted:false`, so the existing job is
 * replayed at the FIFO safe boundary.
 */
export function createConnectorLiveSteerCoordinator(
  deps: ConnectorLiveSteerDependencies
): ConnectorLiveSteerCoordinator {
  const active = new Map<string, ActiveConnectorRun>()

  const handle = async (event: NormalizedInboundEvent): Promise<LiveSteerResult> => {
    const run = active.get(event.conversationKey)
    if (!run) return { activeRun: false, accepted: false }
    const unavailable: LiveSteerResult = {
      activeRun: true,
      accepted: false,
      executionRunId: run.executionRunId,
    }
    if (run.provider !== "anthropic") return unavailable

    try {
      await deps.storeInbound(event, run.sessionId)
      if (!(await deps.admit(event))) return unavailable
      const result = await deps.steer(run.sessionId, event)
      return result.accepted
        ? { activeRun: true, accepted: true, executionRunId: run.executionRunId }
        : unavailable
    } catch {
      return unavailable
    }
  }

  return {
    handle,
    activate(run) {
      active.set(run.conversationKey, run)
      return () => {
        if (active.get(run.conversationKey) === run) active.delete(run.conversationKey)
      }
    },
  }
}
