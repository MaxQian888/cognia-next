/**
 * External-agent rehydration — host-agnostic (ADR-0059 T-A10).
 *
 * Brings persisted external-agent configs back into the running
 * `ExternalAgentManager` on boot and keeps them in sync with plugin-contributed
 * protocol adapters. The desktop `ExternalAgentInitializer` runs this from its
 * React effect (with a StrictMode-safe once-guard + per-effect subscription);
 * the headless brain runs {@link startExternalAgentRehydration} directly from a
 * boot runtime. Both work because `acp-client` already spawns/connects through
 * the transport seam (`agentInvoke`/`agentListen`), so the manager drives the
 * same commands whether they resolve to Tauri `invoke` or a companion RPC call.
 */

import type { ExternalAgentConfig } from "@/types/agent/external-agent"
import { getExternalAgentManager, type ExternalAgentManager } from "./manager"
import {
  getExternalAgentExecutionBlockReason,
  isExternalAgentExecutable,
  isSupportedExternalAgentProtocol,
} from "./config-normalizer"
import { onProtocolAdapterRegistryChange, protocolAdapterRegistry } from "./protocol-adapter"
import { getExternalAgentLifecycleService } from "./lifecycle/service"
import type { ReadinessVerdict } from "./lifecycle/service"
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
export function isRehydratableProtocol(protocol: ExternalAgentConfig["protocol"]): boolean {
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
export async function rehydrateExternalAgent(
  config: ExternalAgentConfig,
  manager: ExternalAgentManager,
  shouldContinue: () => boolean,
  verdict?: ReadinessVerdict
): Promise<void> {
  const store = useExternalAgentStore.getState()

  // The lifecycle verdict gates everything below it. An agent whose adapter is
  // gone, whose credentials cannot be resolved, or whose Windows consent no
  // longer describes what would launch must not be registered at all — the
  // reason is already recorded on the config, so this returns quietly rather
  // than spawning a process that would fail for a reason nothing explained.
  if (verdict && verdict.status !== "ready") {
    store.setConnectionStatus(config.id, "disconnected")
    return
  }

  let runtimeInstance = manager.getAgent(config.id)

  if (!runtimeInstance && isRehydratableProtocol(config.protocol)) {
    try {
      // Startup recovery must register first and connect only after applying
      // the global auto-connect policy below. Calling addAgent without this
      // override would start every enabled external process immediately.
      runtimeInstance = await manager.addAgent(config, { connect: false })
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

/**
 * Everything that must happen before any adapter is constructed.
 *
 * Two steps, in this order and no other:
 *
 *  1. move legacy inline secrets into the keyring, so no connection is ever
 *     built from a config that still carries plaintext;
 *  2. judge every saved agent and disable the ones that cannot honestly start,
 *     recording a structured reason on each.
 *
 * Returns the verdicts so rehydration can use them as a gate. Deliberately
 * calls `reviewAll` rather than `reconcile`: registration and connection are
 * this module's job (with its own timeout and adapter-registry subscription),
 * and reconcile would do them a second time.
 *
 * A failure here must not brick boot — a browser shell with a locked vault
 * would otherwise take the whole startup down — so it degrades to "no verdicts"
 * and lets the existing rehydration path run as it did before.
 */
export async function prepareExternalAgentsForRehydration(): Promise<
  Map<string, ReadinessVerdict>
> {
  try {
    const service = await getExternalAgentLifecycleService()
    await service.migrateLegacyCredentials()
    return await service.reviewAll()
  } catch (error) {
    useExternalAgentStore.setState({
      lastError: error instanceof Error ? error.message : String(error),
    })
    return new Map()
  }
}

/**
 * Start external-agent rehydration for a host that runs it exactly once (the
 * headless brain — no React StrictMode double-invoke). Runs the one-time
 * startup rehydration and subscribes to protocol-adapter registry changes so a
 * plugin enabling its adapter mid-session brings its agents back. Returns a
 * dispose that stops the subscription.
 *
 * The manager (and its health-check interval) is instantiated lazily — only
 * when there is actually an agent to rehydrate — so a brain with no persisted
 * external agents leaves no timers running.
 */
export function startExternalAgentRehydration(): () => void {
  let isActive = true
  const shouldContinue = () => isActive

  void (async () => {
    if (useExternalAgentStore.getState().getAllAgents().length === 0) {
      return
    }

    const verdicts = await prepareExternalAgentsForRehydration()
    if (!isActive) {
      return
    }

    // Re-read: the preparation step rewrites configs (scrubbing migrated
    // secrets) and disables the ones it judged unrunnable.
    const persistedAgents = useExternalAgentStore.getState().getAllAgents()
    const manager = getExternalAgentManager()
    await Promise.all(
      persistedAgents.map((config) =>
        rehydrateExternalAgent(config, manager, shouldContinue, verdicts.get(config.id))
      )
    )
  })()

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
}
