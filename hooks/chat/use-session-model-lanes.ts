"use client"

/**
 * This device's facts about which lane each conversation runs on, for the
 * conversation lists' model labels (`lib/chat/session-model-identity.ts`).
 *
 * The desktop rail, the phone drawer and the conversation filters all need the
 * same three reads, and a list cannot call the composer's per-session hooks
 * once per row.
 */

import { useCallback } from "react"

import type { AgentRuntimeRef } from "@/lib/ai/agent/runtime-catalog/types"
import { useAgentRuntimeStore } from "@/stores/agent/agent-runtime-store"
import { useExternalAgentStore } from "@/stores/agent/external-agent-store"

export interface SessionModelLanes {
  /** Lanes this device recorded per conversation; absent ids never chose one here. */
  sessionRuntimeRefs: Readonly<Record<string, AgentRuntimeRef>>
  /** What an unrecorded conversation's next turn runs on. */
  defaultRuntimeRef: AgentRuntimeRef
  /** A locally configured agent's name. Host-owned agents carry theirs on the ref. */
  agentNameOf: (agentId: string) => string | undefined
}

export function useSessionModelLanes(): SessionModelLanes {
  const sessionRuntimeRefs = useAgentRuntimeStore((s) => s.sessionRuntimeRefs)
  const defaultRuntimeRef = useAgentRuntimeStore((s) => s.runtimeRef)
  const agents = useExternalAgentStore((s) => s.agents)
  const agentNameOf = useCallback(
    (agentId: string) => (Object.hasOwn(agents, agentId) ? agents[agentId]?.name : undefined),
    [agents]
  )
  return { sessionRuntimeRefs, defaultRuntimeRef, agentNameOf }
}

/** The ref this device recorded for one conversation, or `undefined`. */
export function recordedRuntimeRef(
  refs: Readonly<Record<string, AgentRuntimeRef>>,
  sessionId: string
): AgentRuntimeRef | undefined {
  return Object.hasOwn(refs, sessionId) ? refs[sessionId] : undefined
}
