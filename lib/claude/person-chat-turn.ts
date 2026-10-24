import type { ChatSession, SendOptions, SessionEndedEvent } from "@cognia/agent-config-types"
import { mintPersonModelTicket, personChatFailure } from "@/lib/gateway/person-model-ticket"

// Retry state lives only in this process. Every attempt mints a partition ticket;
// the person-brain bootstrap never starts stored-context replay.
const turns = new Map<string, { retry: () => Promise<void>; refreshed: boolean }>()

export function forgetPersonChatTurn(sessionId: string): void {
  turns.delete(sessionId)
}

export async function sendPersonChatTurn(
  session: ChatSession,
  dispatch: (options: SendOptions, refreshed: boolean) => Promise<void>
): Promise<void> {
  const provider = session.providerOverride
  const model = session.model
  if (!provider || !model)
    throw Object.assign(new Error("model_access_unavailable"), { code: "model_access_unavailable" })
  const state = {
    refreshed: false,
    stage: "mint" as "mint" | "send",
    retry: async (): Promise<void> => {
      state.stage = "mint"
      const ticket = await mintPersonModelTicket(provider, model, session.id)
      if (ticket.expiresAt <= Date.now()) {
        if (!state.refreshed) {
          state.refreshed = true
          return state.retry()
        }
        throw Object.assign(new Error("host_surface_forbidden"), { code: "host_surface_forbidden" })
      }
      const { resolveSendOptions } = await import("./build-options")
      const options = await resolveSendOptions({
        personChat: { model, secret: ticket.secret, endpoint: ticket.endpoint },
        capabilityGrants: [
          {
            schemaVersion: 1,
            source: { kind: "cli", id: "person-chat" },
            tools: { restrictTo: [] },
            mcpServers: { only: [] },
            subagents: { only: [] },
            permissionMode: "plan",
            maxTurns: 1,
          },
        ],
      })
      if (turns.get(session.id) !== state) return
      state.stage = "send"
      await dispatch(options, state.refreshed)
    },
  }
  turns.set(session.id, state)
  try {
    try {
      await state.retry()
    } catch (error) {
      // The Host refuses an expired/revoked ticket before sending. A fresh
      // mint is the only recovery; repeat sends remain bounded to one refresh.
      if (
        state.stage !== "send" ||
        personChatFailure(error).code !== "host_surface_forbidden" ||
        state.refreshed
      )
        throw error
      state.refreshed = true
      await state.retry()
    }
  } catch (error) {
    turns.delete(session.id)
    throw error
  }
}

/** A gateway expiry arrives asynchronously as a provider 401, before any call. */
export async function personChatTerminalEvent(
  event: SessionEndedEvent
): Promise<SessionEndedEvent | null> {
  const state = turns.get(event.sessionId)
  if (state && !state.refreshed && event.error && event.httpStatus === 401) {
    state.refreshed = true
    try {
      await state.retry()
      return null
    } catch (error) {
      const failure = personChatFailure(error)
      turns.delete(event.sessionId)
      return { ...event, error: failure.code, ...failure }
    }
  }
  turns.delete(event.sessionId)
  return event
}
