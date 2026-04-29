"use client"

import { useEffect, useRef } from "react"
import { getExternalAgentManager } from "@/lib/ai/agent/external/manager"
import {
  getExternalAgentExecutionBlockReason,
  isExternalAgentExecutable,
} from "@/lib/ai/agent/external/config-normalizer"
import { useExternalAgentStore } from "@/stores/agent/external-agent-store"

export function ExternalAgentInitializer() {
  const hasInitialized = useRef(false)

  useEffect(() => {
    if (hasInitialized.current) {
      return
    }
    hasInitialized.current = true

    let isActive = true

    const initialize = async () => {
      const store = useExternalAgentStore.getState()
      const manager = getExternalAgentManager()
      const persistedAgents = store.getAllAgents()

      for (const config of persistedAgents) {
        if (!isActive) {
          return
        }

        let runtimeInstance = manager.getAgent(config.id)
        const shouldRegisterViaManager = config.protocol === "acp" || config.protocol === "opencode"

        if (!runtimeInstance && shouldRegisterViaManager) {
          try {
            runtimeInstance = await manager.addAgent(config)
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error)
            if (!message.includes("Agent already exists")) {
              store.setConnectionStatus(config.id, "error")
              useExternalAgentStore.setState({
                lastError: message,
              })
            }
          }
        }

        const runtimeBlockedReason =
          runtimeInstance?.validity?.executable === false
            ? runtimeInstance.validity.blockingReason
            : null
        if (runtimeBlockedReason) {
          store.setConnectionStatus(
            config.id,
            runtimeInstance?.connectionStatus ??
              (config.protocol === "acp" ? "disconnected" : "error")
          )
          continue
        }

        const executionBlockedReason = getExternalAgentExecutionBlockReason(config)
        if (executionBlockedReason) {
          store.setConnectionStatus(config.id, config.protocol === "acp" ? "disconnected" : "error")
          continue
        }

        if (!store.autoConnectOnStartup) {
          store.setConnectionStatus(config.id, runtimeInstance?.connectionStatus ?? "disconnected")
          continue
        }

        if (!isExternalAgentExecutable(config)) {
          store.setConnectionStatus(config.id, "error")
          continue
        }

        try {
          await manager.connect(config.id)
          const instance = manager.getAgent(config.id)
          store.setConnectionStatus(config.id, instance?.connectionStatus ?? "connected")
        } catch (error) {
          store.setConnectionStatus(config.id, "error")
          useExternalAgentStore.setState({
            lastError: error instanceof Error ? error.message : String(error),
          })
        }
      }
    }

    void initialize()

    return () => {
      isActive = false
    }
  }, [])

  return null
}

export default ExternalAgentInitializer
