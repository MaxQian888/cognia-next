"use client"

/**
 * Whether the lane a builder conversation runs on can call the builder's
 * tools (ADR-0220), from the protocol of the agent behind it. A host
 * configuration's protocol is not known on this side, so it reads `unknown`
 * and no warning is shown for it.
 */

import { useRuntimeRefForSession } from "@/stores/agent/agent-runtime-store"
import { useExternalAgentStore } from "@/stores/agent/external-agent-store"
import {
  runtimeToolSupport,
  type RuntimeToolSupport,
} from "@/lib/agents/builder/runtime-tool-support"

export function useBuilderToolSupport(sessionId: string | undefined): RuntimeToolSupport {
  const ref = useRuntimeRefForSession(sessionId)
  const externalProtocol = useExternalAgentStore((state) =>
    ref.kind === "external" ? state.agents[ref.agentId]?.protocol : undefined
  )
  return runtimeToolSupport(ref, (target) =>
    target.kind === "external" ? externalProtocol : undefined
  )
}
