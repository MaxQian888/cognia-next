"use client"

/**
 * AgentTeamRuntimeInitializer — registers the Agent Team runtime deps once
 * at app startup so `agentTeamManager.start(teamId)` can dispatch.
 *
 * `configureAgentTeamRuntime` must be called exactly once. The `useRef`
 * guard makes this idempotent even under React 18 Strict Mode's double-
 * invoke. Returns null — this is provider-shaped, not a render component.
 */

import { useEffect, useRef } from "react"
import { configureAgentTeamRuntime } from "@/lib/ai/agent/agent-team"
import { buildAgentTeamRuntimeDeps } from "@/lib/ai/agent/agent-team-runtime-deps"

export function AgentTeamRuntimeInitializer() {
  const hasInitialized = useRef(false)

  useEffect(() => {
    if (hasInitialized.current) return
    hasInitialized.current = true
    configureAgentTeamRuntime(buildAgentTeamRuntimeDeps())
  }, [])

  return null
}

export default AgentTeamRuntimeInitializer
