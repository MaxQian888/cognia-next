/**
 * Convenience wrapper around {@link lastAssistantMessageId} for the spawn call
 * sites, which all want the same "spread this if we could work it out" shape.
 *
 * Reads the chat store directly rather than taking it as a parameter: the spawn
 * paths are already imperative renderer code holding `useTerminalStore
 * .getState()`, and threading a second store through three signatures buys
 * nothing testable that `lastAssistantMessageId` does not already expose.
 */

import { useChatStore } from "@/stores/chat"

import { lastAssistantMessageId } from "./spawner-message"

export function spawnerMessage(chatSessionId: string | null | undefined): {
  agentSpawnerMessageId?: string
} {
  const id = lastAssistantMessageId(useChatStore.getState(), chatSessionId)
  return id ? { agentSpawnerMessageId: id } : {}
}
