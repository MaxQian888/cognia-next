import type { ProtocolAdapter, ProtocolAdapterFactory } from "@cognia/agent-contracts/adapter"
import type { AgentProcessHost, AgentProcessSpawnSpec } from "@cognia/agent-contracts/host"
import type { ExternalAgentConfig } from "@cognia/agent-contracts/external-agent"
import { CodexAppServerAdapter } from "@cognia/agent-codex/app-server-client"
import { loggers } from "@cognia/logging"
import { hasNoLeakingPiiDeep } from "@cognia/redact"
import { transport, isTauri } from "@/lib/tauri"
import { useAccountStore } from "@/stores/account/account-store"
import { configuredApprovalPolicy } from "../policy/tool-preapproval"
import { createAgentLogger } from "../host/agent-logger"
import { createAgentTransportProcessHost } from "../host/process-host"
import { SIWC_APP_SERVER_PROTOCOL } from "../protocol-options"
export { SIWC_APP_SERVER_PROTOCOL, isCodexAppServerProtocol } from "../protocol-options"

function binding(config: ExternalAgentConfig) {
  const siwc = config.metadata?.siwc as Record<string, unknown> | undefined
  const localAccountId = siwc?.localAccountId
  const connectionId = siwc?.connectionId
  if (
    typeof localAccountId !== "string" ||
    !localAccountId.trim() ||
    typeof connectionId !== "string" ||
    !connectionId.trim() ||
    useAccountStore.getState().unlockedAccountId !== localAccountId
  ) {
    throw new Error("SIWC app-server requires its original unlocked local account and connection")
  }
  if (config.transport !== "stdio" || config.process?.command !== "codex" || config.cogniaModel) {
    throw new Error("SIWC app-server requires the native Codex process and dedicated provider")
  }
  return { localAccountId, connectionId }
}

/** Native spawn resolves a scoped capability; OAuth tokens never enter JavaScript or args/env. */
export function createSiwcAppServerAdapterFactory(
  host: AgentProcessHost = createAgentTransportProcessHost("local")
): ProtocolAdapterFactory {
  return () => {
    let selected: ReturnType<typeof binding> | null = null
    const processes = new Map<string, ReturnType<typeof binding>>()
    const protectedHost: AgentProcessHost = {
      ...host,
      get available() {
        return isTauri() && host.available
      },
      spawn: async (spec: AgentProcessSpawnSpec) => {
        if (!selected || useAccountStore.getState().unlockedAccountId !== selected.localAccountId) {
          throw new Error("SIWC app-server connection scope is unavailable")
        }
        const scope = { ...selected }
        let unchanged = true
        const close = useAccountStore.subscribe((state) => {
          if (state.unlockedAccountId !== scope.localAccountId) unchanged = false
        })
        try {
          const processId = await transport.call<string>("siwc_spawn_app_server", {
            ...scope,
            config: {
              id: spec.id,
              command: "codex",
              cwd: spec.cwd,
              sandboxPolicy: spec.sandboxPolicy,
              extraWritableRoots: spec.extraWritableRoots,
              writableCeiling: spec.writableCeiling,
              framing: spec.framing,
            },
          })
          processes.set(processId, scope)
          if (
            !unchanged ||
            !host.available ||
            useAccountStore.getState().unlockedAccountId !== scope.localAccountId
          ) {
            await transport
              .call("siwc_stop_app_server", { ...scope, agentId: processId })
              .catch(() => undefined)
            processes.delete(processId)
            throw new Error("SIWC app-server local account changed during spawn")
          }
          return processId
        } finally {
          close()
        }
      },
      send: async (processId, message) => {
        const scope = processes.get(processId)
        if (
          !scope ||
          !host.available ||
          useAccountStore.getState().unlockedAccountId !== scope.localAccountId
        ) {
          throw new Error("SIWC app-server process scope is unavailable")
        }
        await transport.call("siwc_send_app_server", { ...scope, agentId: processId, message })
      },
      kill: async (processId) => {
        const scope = processes.get(processId) ?? selected
        if (!scope) throw new Error("SIWC app-server process scope is unavailable")
        try {
          await transport.call("siwc_stop_app_server", { ...scope, agentId: processId })
        } finally {
          processes.delete(processId)
        }
      },
    }
    const delegate = new CodexAppServerAdapter({
      processHost: protectedHost,
      // Deliberately bypass buildAgentEnv: it resolves legacy credentials and relay presets.
      resolveLaunchEnvironment: async () => ({}),
      approvalPolicy: configuredApprovalPolicy,
      outboundGate: hasNoLeakingPiiDeep,
      logger: createAgentLogger(loggers.agent),
      onFileChanges: (sessionId, toolUseId, changes) => {
        void import("@/lib/task-workspace/tool-evidence")
          .then(({ recordToolFileChanges }) => recordToolFileChanges(sessionId, toolUseId, changes))
          .catch(() => undefined)
      },
    })
    const bound = new Map<PropertyKey, unknown>()
    // Keep the real adapter prototype so named Codex extension resolution and private state work.
    return new Proxy(delegate, {
      get(target, property) {
        if (property === "protocol") return SIWC_APP_SERVER_PROTOCOL
        if (property === "connect")
          return async (config: ExternalAgentConfig) => {
            const next = binding(config)
            if (
              target.isConnected() &&
              (selected?.localAccountId !== next.localAccountId ||
                selected.connectionId !== next.connectionId)
            ) {
              throw new Error("Disconnect the SIWC process before changing its connection")
            }
            selected = next
            await target.connect({
              ...config,
              process: { ...config.process!, env: {}, args: ["app-server"] },
            })
          }
        const value = Reflect.get(target, property, target)
        if (typeof value !== "function") return value
        if (!bound.has(property)) bound.set(property, value.bind(target))
        return bound.get(property)
      },
    }) as ProtocolAdapter
  }
}
