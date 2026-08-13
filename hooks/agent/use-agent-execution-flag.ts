"use client"

import { useSyncExternalStore } from "react"

import {
  isAgentExecutionFlagEnabled,
  subscribeToAgentExecutionFlags,
  type AgentExecutionFlag,
} from "@/lib/ai/agent/execution/feature-flags"

export function useAgentExecutionFlag(flag: AgentExecutionFlag): boolean {
  return useSyncExternalStore(
    subscribeToAgentExecutionFlags,
    () => isAgentExecutionFlagEnabled(flag),
    () => false
  )
}
