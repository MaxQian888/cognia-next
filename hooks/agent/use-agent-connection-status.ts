"use client"

/**
 * Whether ONE external agent is connected, from the one place that knows.
 *
 * Connection state had two representations. The store holds a shared
 * `connectionStatus` map that the manager's lifecycle listener writes on every
 * runtime transition, and which the runtime selector reads. The manager panel
 * instead rendered its own `agents` array, a copy assembled per hook instance
 * by `refresh()` and rebuilt asynchronously, so between a transition and that
 * rebuild the two surfaces disagreed about the same agent. A user watching one
 * of them connect and the other still say Disconnected was looking at two
 * answers to a question that has one.
 *
 * Reading the map is also cheaper than it looks: the selector returns a string,
 * so a component re-renders when ITS agent moves rather than when any of them
 * does.
 */

import { useExternalAgentStore } from "@/stores/agent/external-agent-store"
import type { ExternalAgentConnectionStatus } from "@/types/agent/external-agent"

/**
 * The map answers whenever it has heard of the agent at all.
 *
 * `fallback` covers only the case where it has not, which is a different
 * question from "disconnected" and is where a caller holding a runtime
 * instance knows more than the map does. The two can never disagree, because
 * the fallback applies only when there is nothing to disagree with.
 */
export function useAgentConnectionStatus(
  agentId: string,
  fallback: ExternalAgentConnectionStatus = "disconnected"
): ExternalAgentConnectionStatus {
  return useExternalAgentStore((state) => state.connectionStatus[agentId] ?? fallback)
}
