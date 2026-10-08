"use client"

import { useEffect, useRef } from "react"
import { createAcpDynamicMcpHostController } from "@/lib/ai/agent/external/runtimes/acp/acp-dynamic-mcp-controller"
import { setAcpDynamicMcpHostController } from "@/lib/ai/agent/external/integrations/acp"
import { getExternalAgentManager, type ExternalAgentManager } from "@/lib/ai/agent/external/manager"
import { onProtocolAdapterRegistryChange } from "@/lib/ai/agent/external/protocol-adapter"
import { rehydrateExternalAgent } from "@/lib/ai/agent/external/session/rehydrate"
import { useExternalAgentStore } from "@/stores/agent/external-agent-store"

/**
 * Binds external-agent rehydration to the desktop webview lifecycle. The
 * per-agent orchestration lives in `lib/ai/agent/external/session/rehydrate` so the
 * headless brain runs the identical logic (ADR-0059 T-A10); this component only
 * adds the React StrictMode-safe once-guard and the mount/unmount subscription.
 *
 * It also owns the connection-status projection for the whole session. The
 * runtime manager knows what it connected, but the store's `connectionStatus`
 * map is what the composer, the runtime selector and every other surface read,
 * and the only listener that kept the map current used to live inside
 * `useExternalAgent` — a hook mounted by three panels and by nothing else. So
 * startup rehydration connected agents that the map never heard about, and an
 * agent could be genuinely connected while every surface outside those panels
 * reported it disconnected, until one of them was opened and refreshed.
 */
export function ExternalAgentInitializer() {
  /**
   * The manager the persisted agents were last rehydrated into. Keyed by
   * instance rather than a once-per-mount flag: a dev hot update can replace
   * the manager (see `LIVE_MANAGER_SLOT` in the manager) while this component
   * survives the refresh, and a flag left the new manager with no agents while
   * the store still said they were connected.
   */
  const rehydratedInto = useRef<ExternalAgentManager | null>(null)

  useEffect(() => {
    let isActive = true
    setAcpDynamicMcpHostController(createAcpDynamicMcpHostController())
    const shouldContinue = () => isActive

    // One-time startup rehydration. Runs every persisted agent in PARALLEL so a
    // single slow/hanging connect cannot block the rest (the old serial loop
    // stalled the whole subsystem behind the first agent).
    //
    // "One-time" per manager, and only for a run that was allowed to finish. A
    // run cancelled by this effect's cleanup (StrictMode's second invocation,
    // or a hot update re-running the effect) stops before it connects, so the
    // next run must redo it rather than find the gate already closed: it used
    // to, and the agents stayed registered but unconnected.
    // `rehydrateExternalAgent` picks up an agent the cancelled run already
    // registered, and `connect` joins one already in flight.
    let rehydrating = false
    const runStartup = async () => {
      const manager = getExternalAgentManager()
      if (rehydratedInto.current === manager) {
        return
      }
      rehydratedInto.current = manager
      rehydrating = true
      const persistedAgents = useExternalAgentStore.getState().getAllAgents()
      try {
        await Promise.all(
          // `rehydrateExternalAgent` writes the startup status itself, on every
          // one of its exits. This listener is for what happens after.
          persistedAgents.map((config) => rehydrateExternalAgent(config, manager, shouldContinue))
        )
      } finally {
        rehydrating = false
      }
    }

    // Bound before the rehydration starts, so a transition that lands while an
    // agent is still connecting is not missed.
    const unbindLifecycle = getExternalAgentManager().addLifecycleListener((event) => {
      if (!isActive) return
      useExternalAgentStore.getState().setConnectionStatus(event.agentId, event.connectionStatus)
    })

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
      // Cancelled before it finished: the next run of this effect owns it.
      if (rehydrating) rehydratedInto.current = null
      unsubscribe()
      unbindLifecycle()
      setAcpDynamicMcpHostController(undefined)
    }
  }, [])

  return null
}

export default ExternalAgentInitializer
