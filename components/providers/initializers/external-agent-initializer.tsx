"use client"

import { useEffect, useRef } from "react"
import type { ExternalAgentConfig } from "@/types/agent/external-agent"
import { getExternalAgentManager, type ExternalAgentManager } from "@/lib/ai/agent/external/manager"
import {
  getExternalAgentExecutionBlockReason,
  isExternalAgentExecutable,
  isSupportedExternalAgentProtocol,
} from "@/lib/ai/agent/external/config-normalizer"
import {
  onProtocolAdapterRegistryChange,
  protocolAdapterRegistry,
} from "@/lib/ai/agent/external/protocol-adapter"
import { useExternalAgentStore } from "@/stores/agent/external-agent-store"

/** Bound the per-agent startup connect so one hanging agent cannot leave the
 * UI stuck on "connecting" forever. The manager keeps its own retry running. */
const STARTUP_CONNECT_TIMEOUT_MS = 30000

/** Reject if `promise` does not settle within `ms`. Does not cancel the work. */
function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), ms)
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

/**
 * A protocol is rehydratable through the manager when it is a built-in
 * executable protocol (acp / opencode) OR a plugin-contributed adapter whose
 * providing plugin is currently enabled (its namespaced protocol sits in the
 * registry). This is what lets a plugin's external agent come back to life
 * exactly when its plugin is on — without hard-coding the built-in protocol set.
 */
function isRehydratableProtocol(protocol: ExternalAgentConfig["protocol"]): boolean {
  if (isSupportedExternalAgentProtocol(protocol)) {
    return true
  }
  return (
    typeof protocol === "string" && protocol.includes(":") && protocolAdapterRegistry.has(protocol)
  )
}

/**
 * Bring one persisted external-agent config into the running manager: register
 * it (if its protocol is available), resolve its blocked/executable state into
 * the store, and auto-connect when the user opted in. Safe to call concurrently
 * for different agents and idempotent for one already in the manager.
 */
async function rehydrateExternalAgent(
  config: ExternalAgentConfig,
  manager: ExternalAgentManager,
  shouldContinue: () => boolean
): Promise<void> {
  const store = useExternalAgentStore.getState()
  let runtimeInstance = manager.getAgent(config.id)

  if (!runtimeInstance && isRehydratableProtocol(config.protocol)) {
    try {
      runtimeInstance = await manager.addAgent(config)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (!message.includes("Agent already exists")) {
        store.setConnectionStatus(config.id, "error")
        useExternalAgentStore.setState({ lastError: message })
      }
      runtimeInstance = manager.getAgent(config.id)
    }
  }
  if (!shouldContinue()) {
    return
  }

  const runtimeBlockedReason =
    runtimeInstance?.validity?.executable === false ? runtimeInstance.validity.blockingReason : null
  if (runtimeBlockedReason) {
    store.setConnectionStatus(
      config.id,
      runtimeInstance?.connectionStatus ?? (config.protocol === "acp" ? "disconnected" : "error")
    )
    return
  }

  const executionBlockedReason = getExternalAgentExecutionBlockReason(config)
  if (executionBlockedReason) {
    store.setConnectionStatus(config.id, config.protocol === "acp" ? "disconnected" : "error")
    return
  }

  if (!store.autoConnectOnStartup) {
    store.setConnectionStatus(config.id, runtimeInstance?.connectionStatus ?? "disconnected")
    return
  }

  if (!isExternalAgentExecutable(config)) {
    store.setConnectionStatus(config.id, "error")
    return
  }

  try {
    await withTimeout(
      manager.connect(config.id),
      STARTUP_CONNECT_TIMEOUT_MS,
      `External agent connect timed out: ${config.id}`
    )
    if (!shouldContinue()) {
      return
    }
    const instance = manager.getAgent(config.id)
    store.setConnectionStatus(config.id, instance?.connectionStatus ?? "connected")
  } catch (error) {
    store.setConnectionStatus(config.id, "error")
    useExternalAgentStore.setState({
      lastError: error instanceof Error ? error.message : String(error),
    })
  }
}

export function ExternalAgentInitializer() {
  const hasInitialized = useRef(false)

  useEffect(() => {
    let isActive = true
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
    }
  }, [])

  return null
}

export default ExternalAgentInitializer
