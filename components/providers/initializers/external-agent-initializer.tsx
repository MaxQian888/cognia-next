"use client"

import { useEffect, useRef } from "react"
import { createAcpDynamicMcpHostController } from "@/lib/ai/agent/external/acp-dynamic-mcp-controller"
import { setAcpDynamicMcpHostController } from "@/lib/ai/agent/external/acp-client"
import { getExternalAgentManager } from "@/lib/ai/agent/external/manager"
import { onProtocolAdapterRegistryChange } from "@/lib/ai/agent/external/protocol-adapter"
import { rehydrateExternalAgent } from "@/lib/ai/agent/external/rehydrate"
import { useExternalAgentStore } from "@/stores/agent/external-agent-store"

/**
 * Binds external-agent rehydration to the desktop webview lifecycle. The
 * per-agent orchestration lives in `lib/ai/agent/external/rehydrate` so the
 * headless brain runs the identical logic (ADR-0059 T-A10); this component only
 * adds the React StrictMode-safe once-guard and the mount/unmount subscription.
 */
export function ExternalAgentInitializer() {
  const hasInitialized = useRef(false)

  useEffect(() => {
    let isActive = true
    setAcpDynamicMcpHostController(createAcpDynamicMcpHostController())
    const shouldContinue = () => isActive

    // One-time startup rehydration. Runs every persisted agent in PARALLEL so a
    // single slow/hanging connect cannot block the rest (the old serial loop
    // stalled the whole subsystem behind the first agent).
    const runStartup = async () => {
      if (hasInitialized.current) {
        return
      }
      hasInitialized.current = true
      const manager = getExternalAgentManager()
      const persistedAgents = useExternalAgentStore.getState().getAllAgents()
      await Promise.all(
        persistedAgents.map((config) => rehydrateExternalAgent(config, manager, shouldContinue))
      )
    }
    void runStartup()

    // React to a plugin enabling its external-agent adapter mid-session: any
    // persisted agent on the newly-available protocol that is not yet in the
    // manager gets rehydrated (the disable side is handled by the bridge tearing
    // the agents down). The store check runs first so an unrelated plugin enable
    // never instantiates the manager.
    const unsubscribe = onProtocolAdapterRegistryChange((change) => {
      if (change.kind !== "register" || !isActive) {
        return
      }
      const candidates = useExternalAgentStore
        .getState()
        .getAllAgents()
        .filter((config) => change.protocols.includes(config.protocol))
      if (candidates.length === 0) {
        return
      }
      const manager = getExternalAgentManager()
      for (const config of candidates) {
        if (!manager.getAgent(config.id)) {
          void rehydrateExternalAgent(config, manager, shouldContinue)
        }
      }
    })

    return () => {
      isActive = false
      unsubscribe()
      setAcpDynamicMcpHostController(undefined)
    }
  }, [])

  return null
}

export default ExternalAgentInitializer
