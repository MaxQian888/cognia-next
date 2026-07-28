import type { CodeServerBrokerNotification, CodeServerBrokerRequest } from "@/lib/codeserver/client"
import { codeServerClient, CODESERVER_EVENTS } from "@/lib/codeserver/client"
import { isWorkspaceTrusted } from "@/lib/db/trusted-workspaces"
import { getPluginManager } from "@/lib/plugin/core/manager"
import { invokePluginApi } from "@/lib/plugin/core/transport"
import { getPluginConsentBroker } from "@/lib/plugin/security/consent-broker"
import { getPermissionGuard } from "@/lib/plugin/security/permission-guard"
import { onTauriEvent } from "@/lib/tauri/events"
import { usePluginStore } from "@/stores/plugin-runtime/plugin-store"
import { useAccountStore } from "@/stores/account/account-store"
import type { Plugin, PluginPermission } from "@/types/plugin"
import type { PluginToolPermissionResult } from "@/types/plugin/plugin-agent-sdk"
import type {
  PluginIdeExecutableResource,
  PluginIdeProtocolServer,
  PluginIdeProviderDeclaration,
} from "@/types/plugin/plugin-ide"

import { IDE_CAPABILITY_CATALOG, IDE_PROVIDER_CATALOG } from "./catalog"
import { normalizeIdeManifest } from "./manifest"
import {
  ManagedProtocolRuntime,
  type ManagedProtocolFamily,
  type ManagedProtocolRequest,
  type ManagedProtocolStart,
} from "./protocol-runtime"

const DEFAULT_PROVIDER_TIMEOUT_MS = 30_000
const CIRCUIT_FAILURE_LIMIT = 3
const CIRCUIT_OPEN_MS = 30_000
const MAX_READ_CONCURRENCY = 8
const MAX_RPC_TRACES = 500
const MAX_AGENT_EVENT_QUEUE = 256

export interface ManagedIdeRpcTrace {
  timestamp: number
  durationMs: number
  method: string
  root: string
  generation: number
  pluginId?: string
  providerId?: string
  operation?: string
  outcome: "success" | "error"
  errorCode?: number
  errorCategory?: string
}

const rpcTraces: ManagedIdeRpcTrace[] = []
let permissionSimulator:
  | ((input: {
      pluginId: string
      permission: PluginPermission
      reason: string
    }) => boolean | undefined)
  | undefined

export function getManagedIdeRpcTraces(): ManagedIdeRpcTrace[] {
  return rpcTraces.map((trace) => ({ ...trace }))
}

export function clearManagedIdeRpcTraces(): void {
  rpcTraces.length = 0
}

export function setManagedIdePermissionSimulator(
  simulator:
    | ((input: {
        pluginId: string
        permission: PluginPermission
        reason: string
      }) => boolean | undefined)
    | undefined
): void {
  if (process.env.NODE_ENV === "production" && simulator) {
    throw brokerError(-32003, "IDE_PERMISSION_SIMULATION_PRODUCTION_FORBIDDEN")
  }
  permissionSimulator = simulator
}

const CONTEXTUAL_PERMISSIONS = new Set<PluginPermission>([
  "shell:execute",
  "process:spawn",
  "debug:control",
  "tests:run",
  "notebook:execute",
  "agent:control",
  "filesystem:write",
])

const WRITE_PERMISSIONS = new Set<PluginPermission>([
  "editor:write",
  "filesystem:write",
  "git:write",
  "shell:execute",
  "process:spawn",
  "debug:control",
  "tests:run",
  "notebook:execute",
  "agent:control",
])

const PROVIDER_EVENTS: Partial<Record<PluginIdeProviderDeclaration["kind"], Set<string>>> = {
  "text-document-content": new Set(["change"]),
  "file-system": new Set(["change"]),
  "tree-data": new Set(["change"]),
  "file-decoration": new Set(["change"]),
  "language-status-item": new Set(["change"]),
  authentication: new Set(["sessionsChanged"]),
  "chat-participant": new Set(["stream", "approval"]),
  "language-model-chat-provider": new Set(["stream", "approval"]),
  "language-model-tool": new Set(["stream", "approval"]),
  "mcp-server-definition": new Set(["definitionsChanged"]),
}

export interface ManagedIdeAgentInvocationContext {
  signal: AbortSignal
  onEvent(event: import("@/lib/claude/run-and-capture").CaptureStreamEvent): void
  requestApproval(
    toolName: string,
    input: Record<string, unknown>
  ): Promise<PluginToolPermissionResult>
}

export interface ManagedIdeBrokerDependencies {
  getPlugin(pluginId: string): Plugin | undefined
  isWorkspaceTrusted(root: string): Promise<boolean>
  validatePaths(root: string, paths: string[]): Promise<string[]>
  createContent(
    root: string,
    generation: number,
    pluginId: string,
    providerId: string,
    permission: PluginPermission | null,
    bytes: Uint8Array
  ): Promise<unknown>
  redeemContent(
    root: string,
    generation: number,
    pluginId: string,
    providerId: string,
    permission: PluginPermission | null,
    handleId: string
  ): Promise<Uint8Array>
  authorize(pluginId: string, permission: PluginPermission, reason: string): Promise<boolean>
  requirePermission(pluginId: string, permission: PluginPermission, reason: string): void
  invoke(pluginId: string, handler: string, args: unknown[]): Promise<unknown>
  invokeAgent(
    agentId: string,
    prompt: string,
    context: ManagedIdeAgentInvocationContext
  ): Promise<unknown>
  protocolStart(input: ManagedProtocolStart): Promise<{
    sessionId: string
    connection?: { endpoint?: string; headers?: Record<string, string>; capabilities?: unknown }
  }>
  protocolRequest(input: ManagedProtocolRequest): Promise<unknown>
  protocolCancel(input: {
    root: string
    generation: number
    pluginId: string
    protocolId: string
    consumerId?: string
    invocationId: string
  }): Promise<boolean>
  protocolDocument(
    input: Omit<ManagedProtocolRequest, "method" | "payload" | "invocationId"> & {
      operation: "open" | "change" | "close"
      uri: string
      languageId?: string
      text?: string
    }
  ): Promise<void>
  protocolStop(input: {
    root: string
    generation: number
    pluginId: string
    protocolId: string
    consumerId?: string
  }): Promise<void>
  getUserId(): string
  stateGet(pluginId: string, scope: ManagedIdeStateScope, key: string): Promise<unknown>
  stateSet(
    pluginId: string,
    scope: ManagedIdeStateScope,
    key: string,
    value: unknown
  ): Promise<void>
  stateDelete(pluginId: string, scope: ManagedIdeStateScope, key: string): Promise<void>
  stateKeys(pluginId: string, scope: ManagedIdeStateScope): Promise<string[]>
  secretGet(pluginId: string, scope: ManagedIdeStateScope, key: string): Promise<string | null>
  secretSet(
    pluginId: string,
    scope: ManagedIdeStateScope,
    key: string,
    value: string
  ): Promise<void>
  secretDelete(pluginId: string, scope: ManagedIdeStateScope, key: string): Promise<void>
  secretKeys(pluginId: string, scope: ManagedIdeStateScope): Promise<string[]>
  expectedHostId: string
  now(): number
}

export interface ManagedIdeStateScope {
  userId: string
  hostId: string
  workspaceRoot: string
  area: "global" | "workspace" | "secrets"
}

export interface ProviderInvokeParams {
  invocationId: string
  pluginId: string
  pluginVersion: string
  manifestHash: string
  catalogHash: string
  hostId: string
  workspaceRoot: string
  workspaceTrusted: boolean
  providerId: string
  providerKind: string
  handler: string
  permission: PluginPermission | null
  operation: string
  arguments: unknown[]
  capabilityTicket?: string
}

interface ProtocolParams {
  invocationId: string
  pluginId: string
  pluginVersion: string
  manifestHash: string
  catalogHash: string
  hostId: string
  workspaceRoot: string
  workspaceTrusted: boolean
  family: ManagedProtocolFamily
  protocolId: string
  consumerId?: string
  capabilityTicket?: string
  method?: string
  payload?: unknown
  document?: {
    operation: "open" | "change" | "close"
    uri: string
    languageId?: string
    text?: string
  }
}

interface ManagedIdeStateParams {
  pluginId: string
  pluginVersion: string
  manifestHash: string
  catalogHash: string
  hostId: string
  workspaceRoot: string
  workspaceTrusted: boolean
  area: "global" | "workspace"
  key?: string
  value?: unknown
}

interface CircuitState {
  failures: number
  openUntil: number
}

interface InflightInvocation {
  controller: AbortController
  pluginId: string
  providerId: string
  operation: string
  eventTail: Promise<void>
  queuedEvents: number
  approvals: Map<
    string,
    {
      resolve: (decision: PluginToolPermissionResult) => void
      reject: (error: unknown) => void
    }
  >
}

interface InflightProtocolInvocation {
  controller: AbortController
  root: string
  generation: number
  invocationId: string
  pluginId: string
  protocolId: string
  consumerId?: string
}

export class ManagedIdeBrokerRuntime {
  private readonly generations = new Map<string, number>()
  private readonly circuits = new Map<string, CircuitState>()
  private readonly tickets = new Map<string, { scope: string; expiresAt: number }>()
  private readonly protocolTickets = new Map<string, { scope: string; expiresAt: number }>()
  private readonly inflight = new Map<string, InflightInvocation>()
  private readonly inflightProtocols = new Map<string, InflightProtocolInvocation>()
  private readonly scheduler = new ProviderScheduler(MAX_READ_CONCURRENCY)

  constructor(
    private readonly dependencies: ManagedIdeBrokerDependencies = createManagedIdeBrokerDependencies()
  ) {}

  async dispatch(request: CodeServerBrokerRequest): Promise<unknown> {
    const startedAt = this.dependencies.now()
    try {
      const result = await this.dispatchInner(request)
      this.recordTrace(request, startedAt, "success")
      return result
    } catch (error) {
      this.recordTrace(request, startedAt, "error", error)
      throw error
    }
  }

  private async dispatchInner(request: CodeServerBrokerRequest): Promise<unknown> {
    if (request.method.startsWith("cognia/protocol/")) {
      return this.dispatchProtocol(request)
    }
    if (
      request.method.startsWith("cognia/state/") ||
      request.method.startsWith("cognia/secrets/")
    ) {
      return this.dispatchManagedStorage(request)
    }
    if (request.method !== "cognia/provider/invoke") {
      throw brokerError(-32601, "IDE_BROKER_METHOD_NOT_FOUND", request.method)
    }
    const params = validateInvokeParams(request.params)
    this.acceptGeneration(request.root, request.generation)
    if (params.workspaceRoot !== request.root) {
      throw brokerError(-32002, "IDE_WORKSPACE_SCOPE_MISMATCH", params.workspaceRoot)
    }
    if (params.hostId !== this.dependencies.expectedHostId) {
      throw brokerError(-32002, "IDE_HOST_SCOPE_MISMATCH", params.hostId)
    }
    if (!params.workspaceTrusted || !(await this.dependencies.isWorkspaceTrusted(request.root))) {
      throw brokerError(-32003, "IDE_WORKSPACE_UNTRUSTED", request.root)
    }

    const plugin = this.dependencies.getPlugin(params.pluginId)
    if (!plugin || plugin.status !== "enabled") {
      throw brokerError(-32004, "IDE_PLUGIN_NOT_ACTIVE", params.pluginId)
    }
    if (plugin.manifest.version !== params.pluginVersion) {
      throw brokerError(-32001, "IDE_PLUGIN_VERSION_MISMATCH", params.pluginVersion)
    }
    if (params.catalogHash !== IDE_CAPABILITY_CATALOG.catalogHash) {
      throw brokerError(-32001, "IDE_CATALOG_MISMATCH", params.catalogHash)
    }

    const normalized = normalizeIdeManifest(params.pluginId, plugin.manifest).manifest
    const expectedHash = await hashIdeManifest(normalized)
    if (params.manifestHash !== expectedHash) {
      throw brokerError(-32001, "IDE_MANIFEST_HASH_MISMATCH", params.manifestHash)
    }
    const provider = findProvider(normalized.providers, params)
    await this.authorizeProvider(plugin, provider, params)
    const providerArguments = (await transformContentHandles(params.arguments, {
      decode: (handleId) =>
        this.dependencies.redeemContent(
          request.root,
          request.generation,
          params.pluginId,
          params.providerId,
          provider.permission ?? null,
          handleId
        ),
    })) as unknown[]
    const hostPaths = collectHostPaths(providerArguments)
    if (hostPaths.length > 0) {
      await this.dependencies.validatePaths(request.root, hostPaths)
    }

    const circuitKey = `${params.pluginId}:${params.providerId}`
    this.assertCircuitClosed(circuitKey)
    const timeoutMs = provider.metadata?.timeoutMs
    const deadline =
      typeof timeoutMs === "number" && timeoutMs > 0
        ? Math.min(timeoutMs, DEFAULT_PROVIDER_TIMEOUT_MS)
        : DEFAULT_PROVIDER_TIMEOUT_MS
    const invocationKey = this.invocationKey(request.root, request.generation, params.invocationId)
    if (this.inflight.has(invocationKey)) {
      throw brokerError(-32600, "IDE_DUPLICATE_INVOCATION_ID", params.invocationId)
    }
    const controller = new AbortController()
    this.inflight.set(invocationKey, {
      controller,
      pluginId: params.pluginId,
      providerId: params.providerId,
      operation: params.operation,
      eventTail: Promise.resolve(),
      queuedEvents: 0,
      approvals: new Map(),
    })
    const operation = async () => {
      const invocation = this.inflight.get(invocationKey)
      if (!invocation) {
        throw brokerError(-32800, "IDE_PROVIDER_CANCELLED", params.invocationId)
      }
      const result = await withDeadline(
        provider.handler.startsWith("$agent:")
          ? this.dependencies.invokeAgent(
              provider.handler.slice("$agent:".length),
              agentPrompt(providerArguments),
              {
                signal: controller.signal,
                onEvent: (event) => {
                  this.queueInvocationEvent({
                    request,
                    params,
                    provider,
                    invocationKey,
                    invocation,
                    event: "stream",
                    payload: event,
                  })
                },
                requestApproval: (toolName, input) =>
                  this.requestAgentApproval({
                    request,
                    params,
                    provider,
                    invocationKey,
                    invocation,
                    toolName,
                    input,
                  }),
              }
            )
          : this.dependencies.invoke(params.pluginId, provider.handler, [
              params.operation,
              ...providerArguments,
            ]),
        deadline,
        controller.signal
      )
      await invocation.eventTail
      return result
    }
    const write = provider.permission ? WRITE_PERMISSIONS.has(provider.permission) : false
    const key = `${request.root}:${params.providerId}`
    try {
      const result = await this.scheduler.run(key, write, operation)
      this.circuits.delete(circuitKey)
      return await transformContentHandles(result, {
        encode: (bytes) =>
          this.dependencies.createContent(
            request.root,
            request.generation,
            params.pluginId,
            params.providerId,
            provider.permission ?? null,
            bytes
          ),
      })
    } catch (error) {
      if (!isCancellationError(error)) this.recordFailure(circuitKey)
      throw error
    } finally {
      if (this.inflight.get(invocationKey)?.controller === controller) {
        this.rejectApprovals(
          this.inflight.get(invocationKey),
          brokerError(-32800, "IDE_PROVIDER_INVOCATION_CLOSED", params.invocationId)
        )
        this.inflight.delete(invocationKey)
      }
    }
  }

  private async dispatchManagedStorage(request: CodeServerBrokerRequest): Promise<unknown> {
    const params = validateManagedIdeStateParams(request.method, request.params)
    this.acceptGeneration(request.root, request.generation)
    const plugin = await this.validateManagedStorageScope(request, params)
    const secret = request.method.startsWith("cognia/secrets/")
    const operation = request.method.slice(request.method.lastIndexOf("/") + 1)
    if (secret) {
      const permission: PluginPermission =
        operation === "get" || operation === "keys" ? "secrets:read" : "secrets:write"
      if (!(plugin.manifest.permissions ?? []).includes(permission)) {
        throw brokerError(-32003, "IDE_PERMISSION_NOT_DECLARED", permission)
      }
      this.dependencies.requirePermission(
        params.pluginId,
        permission,
        `Managed IDE secret storage ${operation}`
      )
    }
    const scope: ManagedIdeStateScope = {
      userId: this.dependencies.getUserId(),
      hostId: params.hostId,
      workspaceRoot: request.root,
      area: secret ? "secrets" : params.area,
    }
    if (!scope.userId) {
      throw brokerError(-32002, "IDE_USER_SCOPE_UNAVAILABLE")
    }
    switch (request.method) {
      case "cognia/state/get":
        return this.dependencies.stateGet(params.pluginId, scope, params.key!)
      case "cognia/state/set":
        await this.dependencies.stateSet(params.pluginId, scope, params.key!, params.value)
        return null
      case "cognia/state/delete":
        await this.dependencies.stateDelete(params.pluginId, scope, params.key!)
        return null
      case "cognia/state/keys":
        return this.dependencies.stateKeys(params.pluginId, scope)
      case "cognia/secrets/get":
        return this.dependencies.secretGet(params.pluginId, scope, params.key!)
      case "cognia/secrets/set":
        await this.dependencies.secretSet(
          params.pluginId,
          scope,
          params.key!,
          params.value as string
        )
        return null
      case "cognia/secrets/delete":
        await this.dependencies.secretDelete(params.pluginId, scope, params.key!)
        return null
      case "cognia/secrets/keys":
        return this.dependencies.secretKeys(params.pluginId, scope)
      default:
        throw brokerError(-32601, "IDE_BROKER_METHOD_NOT_FOUND", request.method)
    }
  }

  private async validateManagedStorageScope(
    request: CodeServerBrokerRequest,
    params: ManagedIdeStateParams
  ): Promise<Plugin> {
    if (params.workspaceRoot !== request.root) {
      throw brokerError(-32002, "IDE_WORKSPACE_SCOPE_MISMATCH", params.workspaceRoot)
    }
    if (params.hostId !== this.dependencies.expectedHostId) {
      throw brokerError(-32002, "IDE_HOST_SCOPE_MISMATCH", params.hostId)
    }
    if (!params.workspaceTrusted || !(await this.dependencies.isWorkspaceTrusted(request.root))) {
      throw brokerError(-32003, "IDE_WORKSPACE_UNTRUSTED", request.root)
    }
    const plugin = this.dependencies.getPlugin(params.pluginId)
    if (!plugin || plugin.status !== "enabled") {
      throw brokerError(-32004, "IDE_PLUGIN_NOT_ACTIVE", params.pluginId)
    }
    if (plugin.manifest.version !== params.pluginVersion) {
      throw brokerError(-32001, "IDE_PLUGIN_VERSION_MISMATCH", params.pluginVersion)
    }
    if (params.catalogHash !== IDE_CAPABILITY_CATALOG.catalogHash) {
      throw brokerError(-32001, "IDE_CATALOG_MISMATCH", params.catalogHash)
    }
    const normalized = normalizeIdeManifest(params.pluginId, plugin.manifest).manifest
    if (params.manifestHash !== (await hashIdeManifest(normalized))) {
      throw brokerError(-32001, "IDE_MANIFEST_HASH_MISMATCH", params.manifestHash)
    }
    return plugin
  }

  private async dispatchProtocol(request: CodeServerBrokerRequest): Promise<unknown> {
    const params = validateProtocolParams(request.params)
    this.acceptGeneration(request.root, request.generation)
    const { plugin, server, executable } = await this.validateProtocolScope(request, params)
    const permission: PluginPermission = params.family === "dap" ? "debug:control" : "process:spawn"
    if (!(plugin.manifest.permissions ?? []).includes(permission)) {
      throw brokerError(-32003, "IDE_PERMISSION_NOT_DECLARED", permission)
    }
    const scope = `${request.root}:${request.generation}:${params.pluginId}:${params.protocolId}:${params.consumerId ?? "shared"}:${permission}`
    this.dependencies.requirePermission(
      params.pluginId,
      permission,
      `Managed IDE ${params.family} protocol callback`
    )

    if (request.method === "cognia/protocol/start") {
      if (
        !(await this.dependencies.authorize(
          params.pluginId,
          permission,
          `Managed IDE ${params.family} protocol start`
        ))
      ) {
        throw brokerError(-32003, "IDE_CONTEXTUAL_CONFIRMATION_DENIED", permission)
      }
      const result = await this.dependencies.protocolStart({
        root: request.root,
        generation: request.generation,
        pluginId: params.pluginId,
        pluginVersion: params.pluginVersion,
        manifestHash: params.manifestHash,
        consumerId: params.consumerId,
        family: params.family,
        server,
        executable,
      })
      const capabilityTicket = crypto.randomUUID()
      this.protocolTickets.set(capabilityTicket, {
        scope,
        expiresAt: this.dependencies.now() + 5 * 60_000,
      })
      return { ...result, capabilityTicket }
    }

    if (!params.capabilityTicket || !this.validateProtocolTicket(params.capabilityTicket, scope)) {
      throw brokerError(-32003, "IDE_CAPABILITY_TICKET_INVALID", params.protocolId)
    }
    if (request.method === "cognia/protocol/request") {
      if (typeof params.method !== "string" || params.method.length === 0) {
        throw brokerError(-32602, "IDE_PROTOCOL_METHOD_REQUIRED")
      }
      const hostPaths = collectHostPaths(params.payload)
      if (hostPaths.length > 0) {
        await this.dependencies.validatePaths(request.root, hostPaths)
      }
      const invocationKey = this.invocationKey(
        request.root,
        request.generation,
        params.invocationId
      )
      if (this.inflightProtocols.has(invocationKey)) {
        throw brokerError(-32600, "IDE_DUPLICATE_INVOCATION_ID", params.invocationId)
      }
      const controller = new AbortController()
      this.inflightProtocols.set(invocationKey, {
        controller,
        root: request.root,
        generation: request.generation,
        invocationId: params.invocationId,
        pluginId: params.pluginId,
        protocolId: params.protocolId,
        consumerId: params.consumerId,
      })
      try {
        return await withAbort(
          this.dependencies.protocolRequest({
            root: request.root,
            generation: request.generation,
            pluginId: params.pluginId,
            family: params.family,
            protocolId: params.protocolId,
            consumerId: params.consumerId,
            invocationId: params.invocationId,
            method: params.method,
            payload: params.payload,
          }),
          controller.signal
        )
      } finally {
        if (this.inflightProtocols.get(invocationKey)?.controller === controller) {
          this.inflightProtocols.delete(invocationKey)
        }
      }
    }
    if (request.method === "cognia/protocol/document") {
      if (!params.document) {
        throw brokerError(-32602, "IDE_PROTOCOL_DOCUMENT_REQUIRED")
      }
      const hostPaths = collectHostPaths(params.document)
      if (hostPaths.length > 0) {
        await this.dependencies.validatePaths(request.root, hostPaths)
      }
      await this.dependencies.protocolDocument({
        root: request.root,
        generation: request.generation,
        pluginId: params.pluginId,
        family: params.family,
        protocolId: params.protocolId,
        consumerId: params.consumerId,
        ...params.document,
      })
      return null
    }
    if (request.method === "cognia/protocol/stop") {
      await this.dependencies.protocolStop({
        root: request.root,
        generation: request.generation,
        pluginId: params.pluginId,
        protocolId: params.protocolId,
        consumerId: params.consumerId,
      })
      this.protocolTickets.delete(params.capabilityTicket)
      return null
    }
    throw brokerError(-32601, "IDE_BROKER_METHOD_NOT_FOUND", request.method)
  }

  private async validateProtocolScope(
    request: CodeServerBrokerRequest,
    params: ProtocolParams
  ): Promise<{
    plugin: Plugin
    server: PluginIdeProtocolServer
    executable: PluginIdeExecutableResource
  }> {
    if (params.workspaceRoot !== request.root) {
      throw brokerError(-32002, "IDE_WORKSPACE_SCOPE_MISMATCH", params.workspaceRoot)
    }
    if (params.hostId !== this.dependencies.expectedHostId) {
      throw brokerError(-32002, "IDE_HOST_SCOPE_MISMATCH", params.hostId)
    }
    if (!params.workspaceTrusted || !(await this.dependencies.isWorkspaceTrusted(request.root))) {
      throw brokerError(-32003, "IDE_WORKSPACE_UNTRUSTED", request.root)
    }
    const plugin = this.dependencies.getPlugin(params.pluginId)
    if (!plugin || plugin.status !== "enabled") {
      throw brokerError(-32004, "IDE_PLUGIN_NOT_ACTIVE", params.pluginId)
    }
    if (plugin.manifest.version !== params.pluginVersion) {
      throw brokerError(-32001, "IDE_PLUGIN_VERSION_MISMATCH", params.pluginVersion)
    }
    if (params.catalogHash !== IDE_CAPABILITY_CATALOG.catalogHash) {
      throw brokerError(-32001, "IDE_CATALOG_MISMATCH", params.catalogHash)
    }
    const normalized = normalizeIdeManifest(params.pluginId, plugin.manifest).manifest
    if (params.manifestHash !== (await hashIdeManifest(normalized))) {
      throw brokerError(-32001, "IDE_MANIFEST_HASH_MISMATCH", params.manifestHash)
    }
    const server = normalized.protocols[params.family].find(
      (entry) => entry.id === params.protocolId
    )
    if (!server) {
      throw brokerError(-32004, "IDE_PROTOCOL_NOT_DECLARED", params.protocolId)
    }
    const executable = normalized.executables.find((entry) => entry.id === server.executable)
    if (!executable) {
      throw brokerError(-32004, "IDE_EXECUTABLE_NOT_DECLARED", server.executable)
    }
    return { plugin, server, executable }
  }

  private validateProtocolTicket(ticket: string, scope: string): boolean {
    const value = this.protocolTickets.get(ticket)
    if (!value || value.scope !== scope || value.expiresAt < this.dependencies.now()) {
      this.protocolTickets.delete(ticket)
      return false
    }
    value.expiresAt = this.dependencies.now() + 5 * 60_000
    return true
  }

  cancel(notification: CodeServerBrokerNotification): boolean {
    if (this.generations.get(notification.root) !== notification.generation) return false
    if (notification.method === "cognia/protocol/cancel") {
      const params = validateProtocolCancellationParams(notification.params)
      const invocation = this.inflightProtocols.get(
        this.invocationKey(notification.root, notification.generation, params.invocationId)
      )
      if (
        !invocation ||
        invocation.pluginId !== params.pluginId ||
        invocation.protocolId !== params.protocolId ||
        invocation.consumerId !== params.consumerId
      ) {
        return false
      }
      invocation.controller.abort(
        brokerError(-32800, "IDE_PROTOCOL_CANCELLED", params.invocationId)
      )
      void this.dependencies.protocolCancel({
        root: notification.root,
        generation: notification.generation,
        pluginId: params.pluginId,
        protocolId: params.protocolId,
        consumerId: params.consumerId,
        invocationId: params.invocationId,
      })
      return true
    }
    if (notification.method === "cognia/provider/approvalResponse") {
      const params = validateApprovalResponseParams(notification.params)
      const invocation = this.inflight.get(
        this.invocationKey(notification.root, notification.generation, params.invocationId)
      )
      if (
        !invocation ||
        invocation.pluginId !== params.pluginId ||
        invocation.providerId !== params.providerId
      ) {
        return false
      }
      const approval = invocation.approvals.get(params.requestId)
      if (!approval) return false
      invocation.approvals.delete(params.requestId)
      approval.resolve(
        params.decision === "allow"
          ? {
              behavior: "allow",
              ...(params.updatedInput ? { updatedInput: params.updatedInput } : {}),
            }
          : { behavior: "deny", message: params.message ?? "Denied in Pro IDE" }
      )
      return true
    }
    if (notification.method !== "cognia/provider/cancel") return false
    const params = validateCancellationParams(notification.params)
    const invocation = this.inflight.get(
      this.invocationKey(notification.root, notification.generation, params.invocationId)
    )
    if (
      !invocation ||
      invocation.pluginId !== params.pluginId ||
      invocation.providerId !== params.providerId ||
      invocation.operation !== params.operation
    ) {
      return false
    }
    invocation.controller.abort(brokerError(-32800, "IDE_PROVIDER_CANCELLED", params.invocationId))
    this.rejectApprovals(
      invocation,
      brokerError(-32800, "IDE_PROVIDER_CANCELLED", params.invocationId)
    )
    return true
  }

  private queueInvocationEvent(input: {
    request: CodeServerBrokerRequest
    params: ProviderInvokeParams
    provider: PluginIdeProviderDeclaration
    invocationKey: string
    invocation: InflightInvocation
    event: "stream" | "approval"
    payload: unknown
  }): void {
    if (
      input.invocation.controller.signal.aborted ||
      this.inflight.get(input.invocationKey) !== input.invocation
    ) {
      return
    }
    input.invocation.queuedEvents += 1
    if (input.invocation.queuedEvents > MAX_AGENT_EVENT_QUEUE) {
      const error = brokerError(-32010, "IDE_AGENT_EVENT_QUEUE_SATURATED", {
        capacity: MAX_AGENT_EVENT_QUEUE,
      })
      input.invocation.controller.abort(error)
      this.rejectApprovals(input.invocation, error)
      return
    }
    input.invocation.eventTail = input.invocation.eventTail
      .then(() => this.emitInvocationEvent(input))
      .catch((error) => {
        input.invocation.controller.abort(error)
        this.rejectApprovals(input.invocation, error)
        throw error
      })
      .finally(() => {
        input.invocation.queuedEvents -= 1
      })
  }

  private requestAgentApproval(input: {
    request: CodeServerBrokerRequest
    params: ProviderInvokeParams
    provider: PluginIdeProviderDeclaration
    invocationKey: string
    invocation: InflightInvocation
    toolName: string
    input: Record<string, unknown>
  }): Promise<PluginToolPermissionResult> {
    if (
      input.invocation.controller.signal.aborted ||
      this.inflight.get(input.invocationKey) !== input.invocation
    ) {
      return Promise.reject(
        brokerError(-32800, "IDE_PROVIDER_CANCELLED", input.params.invocationId)
      )
    }
    const requestId = crypto.randomUUID()
    const decision = new Promise<PluginToolPermissionResult>((resolve, reject) => {
      input.invocation.approvals.set(requestId, { resolve, reject })
    })
    this.queueInvocationEvent({
      ...input,
      event: "approval",
      payload: {
        requestId,
        toolName: input.toolName,
        input: input.input,
      },
    })
    return decision
  }

  private async emitInvocationEvent(input: {
    request: CodeServerBrokerRequest
    params: ProviderInvokeParams
    provider: PluginIdeProviderDeclaration
    invocationKey: string
    invocation: InflightInvocation
    event: "stream" | "approval"
    payload: unknown
  }): Promise<void> {
    if (
      this.inflight.get(input.invocationKey) !== input.invocation ||
      input.invocation.controller.signal.aborted ||
      this.generations.get(input.request.root) !== input.request.generation
    ) {
      throw brokerError(-32800, "IDE_PROVIDER_INVOCATION_STALE", input.params.invocationId)
    }
    if (!(await this.dependencies.isWorkspaceTrusted(input.request.root))) {
      throw brokerError(-32003, "IDE_WORKSPACE_UNTRUSTED", input.request.root)
    }
    const plugin = this.dependencies.getPlugin(input.params.pluginId)
    if (!plugin || plugin.status !== "enabled") {
      throw brokerError(-32004, "IDE_PLUGIN_NOT_ACTIVE", input.params.pluginId)
    }
    const normalized = normalizeIdeManifest(input.params.pluginId, plugin.manifest).manifest
    const declared = normalized.providers.find((entry) => entry.id === input.params.providerId)
    if (
      !declared ||
      declared.kind !== input.provider.kind ||
      !PROVIDER_EVENTS[declared.kind]?.has(input.event)
    ) {
      throw brokerError(
        -32602,
        "IDE_PROVIDER_EVENT_UNSUPPORTED",
        `${input.provider.kind}:${input.event}`
      )
    }
    if (declared.permission) {
      this.dependencies.requirePermission(
        input.params.pluginId,
        declared.permission,
        `Managed IDE ${declared.kind}:${input.event}`
      )
    }
    await codeServerClient.notifyBroker(input.request.root, input.request.generation, {
      pluginId: input.params.pluginId,
      providerId: input.params.providerId,
      invocationId: input.params.invocationId,
      event: input.event,
      payload: input.payload,
    })
  }

  private rejectApprovals(invocation: InflightInvocation | undefined, error: unknown): void {
    if (!invocation) return
    for (const approval of invocation.approvals.values()) approval.reject(error)
    invocation.approvals.clear()
  }

  async emitProviderEvent(input: {
    root: string
    pluginId: string
    providerId: string
    event: string
    payload?: unknown
  }): Promise<void> {
    const generation = this.generations.get(input.root)
    if (generation === undefined) {
      throw brokerError(-32005, "IDE_BROKER_NOT_CONNECTED", input.root)
    }
    if (!(await this.dependencies.isWorkspaceTrusted(input.root))) {
      throw brokerError(-32003, "IDE_WORKSPACE_UNTRUSTED", input.root)
    }
    const plugin = this.dependencies.getPlugin(input.pluginId)
    if (!plugin || plugin.status !== "enabled") {
      throw brokerError(-32004, "IDE_PLUGIN_NOT_ACTIVE", input.pluginId)
    }
    const normalized = normalizeIdeManifest(input.pluginId, plugin.manifest).manifest
    const provider = normalized.providers.find((entry) => entry.id === input.providerId)
    if (!provider) {
      throw brokerError(-32004, "IDE_PROVIDER_NOT_DECLARED", input.providerId)
    }
    if (!PROVIDER_EVENTS[provider.kind]?.has(input.event)) {
      throw brokerError(-32602, "IDE_PROVIDER_EVENT_UNSUPPORTED", `${provider.kind}:${input.event}`)
    }
    if (
      provider.permission &&
      (!(plugin.manifest.permissions ?? []).includes(provider.permission) ||
        !(await this.dependencies.authorize(
          input.pluginId,
          provider.permission,
          `Managed IDE ${provider.kind}:${input.event}`
        )))
    ) {
      throw brokerError(-32003, "IDE_PERMISSION_DENIED", provider.permission)
    }
    await codeServerClient.notifyBroker(input.root, generation, {
      pluginId: input.pluginId,
      providerId: input.providerId,
      event: input.event,
      payload: input.payload,
    })
  }

  disconnect(root: string): void {
    this.retireRoot(root, brokerError(-32005, "IDE_BROKER_DISCONNECTED", root))
    this.generations.delete(root)
  }

  private recordTrace(
    request: CodeServerBrokerRequest,
    startedAt: number,
    outcome: ManagedIdeRpcTrace["outcome"],
    error?: unknown
  ): void {
    const params =
      request.params && typeof request.params === "object"
        ? (request.params as Record<string, unknown>)
        : {}
    const structured = error === undefined ? undefined : toStructuredError(error)
    rpcTraces.push({
      timestamp: startedAt,
      durationMs: Math.max(0, this.dependencies.now() - startedAt),
      method: request.method,
      root: request.root,
      generation: request.generation,
      ...(typeof params.pluginId === "string" ? { pluginId: params.pluginId } : {}),
      ...(typeof params.providerId === "string" ? { providerId: params.providerId } : {}),
      ...(typeof params.operation === "string" ? { operation: params.operation } : {}),
      outcome,
      ...(structured ? { errorCode: structured.code, errorCategory: structured.message } : {}),
    })
    if (rpcTraces.length > MAX_RPC_TRACES) {
      rpcTraces.splice(0, rpcTraces.length - MAX_RPC_TRACES)
    }
  }

  private invocationKey(root: string, generation: number, invocationId: string): string {
    return `${root}\0${generation}\0${invocationId}`
  }

  private acceptGeneration(root: string, generation: number): void {
    const current = this.generations.get(root)
    if (current !== undefined && generation < current) {
      throw brokerError(-32005, "IDE_STALE_GENERATION", String(generation))
    }
    if (current !== generation) {
      if (current !== undefined) {
        this.retireRoot(
          root,
          brokerError(-32005, "IDE_CONNECTION_GENERATION_REPLACED", {
            previous: current,
            current: generation,
          })
        )
      }
      this.generations.set(root, generation)
      for (const ticket of this.tickets.keys()) {
        if (ticket.startsWith(`${root}:`)) this.tickets.delete(ticket)
      }
      for (const [ticket, value] of this.protocolTickets) {
        if (value.scope.startsWith(`${root}:`)) this.protocolTickets.delete(ticket)
      }
    }
  }

  private retireRoot(root: string, error: Error): void {
    const prefix = `${root}\0`
    for (const [key, invocation] of this.inflight) {
      if (!key.startsWith(prefix)) continue
      invocation.controller.abort(error)
      this.rejectApprovals(invocation, error)
    }
    for (const [key, invocation] of this.inflightProtocols) {
      if (!key.startsWith(prefix)) continue
      this.inflightProtocols.delete(key)
      invocation.controller.abort(error)
      void this.dependencies.protocolCancel({
        root: invocation.root,
        generation: invocation.generation,
        pluginId: invocation.pluginId,
        protocolId: invocation.protocolId,
        consumerId: invocation.consumerId,
        invocationId: invocation.invocationId,
      })
    }
    for (const ticket of this.tickets.keys()) {
      if (ticket.startsWith(`${root}:`)) this.tickets.delete(ticket)
    }
    for (const [ticket, value] of this.protocolTickets) {
      if (value.scope.startsWith(`${root}:`)) this.protocolTickets.delete(ticket)
    }
  }

  private async authorizeProvider(
    plugin: Plugin,
    provider: PluginIdeProviderDeclaration,
    params: ProviderInvokeParams
  ): Promise<void> {
    const permission = provider.permission
    if (!permission) return
    if (!(plugin.manifest.permissions ?? []).includes(permission)) {
      throw brokerError(-32003, "IDE_PERMISSION_NOT_DECLARED", permission)
    }
    const reason = `Managed IDE ${provider.kind}:${params.operation}`
    if (!CONTEXTUAL_PERMISSIONS.has(permission)) {
      if (!(await this.dependencies.authorize(params.pluginId, permission, reason))) {
        throw brokerError(-32003, "IDE_PERMISSION_DENIED", permission)
      }
      return
    }

    const scope = `${params.workspaceRoot}:${params.pluginId}:${params.providerId}:${permission}`
    if (params.capabilityTicket && this.consumeTicket(params.capabilityTicket, scope)) return
    if (!(await this.dependencies.authorize(params.pluginId, permission, reason))) {
      throw brokerError(-32003, "IDE_CONTEXTUAL_CONFIRMATION_DENIED", permission)
    }
    const ticket = this.issueTicket(scope)
    if (!this.consumeTicket(ticket, scope)) {
      throw brokerError(-32603, "IDE_CAPABILITY_TICKET_INVALID", permission)
    }
  }

  private issueTicket(scope: string): string {
    const token = `${scope}:${crypto.randomUUID()}`
    this.tickets.set(token, { scope, expiresAt: this.dependencies.now() + 30_000 })
    return token
  }

  private consumeTicket(token: string, scope: string): boolean {
    const ticket = this.tickets.get(token)
    this.tickets.delete(token)
    return Boolean(ticket && ticket.scope === scope && ticket.expiresAt >= this.dependencies.now())
  }

  private assertCircuitClosed(key: string): void {
    const circuit = this.circuits.get(key)
    if (!circuit) return
    if (circuit.openUntil > 0 && circuit.openUntil <= this.dependencies.now()) {
      this.circuits.delete(key)
      return
    }
    if (circuit.openUntil === 0) return
    throw brokerError(-32010, "IDE_PROVIDER_CIRCUIT_OPEN", key)
  }

  private recordFailure(key: string): void {
    const previous = this.circuits.get(key) ?? { failures: 0, openUntil: 0 }
    const failures = previous.failures + 1
    this.circuits.set(key, {
      failures,
      openUntil: failures >= CIRCUIT_FAILURE_LIMIT ? this.dependencies.now() + CIRCUIT_OPEN_MS : 0,
    })
  }
}

export async function attachManagedIdeBroker(
  runtime = new ManagedIdeBrokerRuntime()
): Promise<() => void> {
  const unlistenRequest = await onTauriEvent<CodeServerBrokerRequest>(
    CODESERVER_EVENTS.brokerRequest,
    (request) => {
      void runtime.dispatch(request).then(
        (result) => codeServerClient.respondToBroker(request, { result }),
        (error) =>
          codeServerClient.respondToBroker(request, {
            error: toStructuredError(error),
          })
      )
    }
  )
  const unlistenNotification = await onTauriEvent<CodeServerBrokerNotification>(
    CODESERVER_EVENTS.brokerNotification,
    (notification) => {
      runtime.cancel(notification)
    }
  )
  const unlistenExit = await onTauriEvent<{ root: string }>(
    CODESERVER_EVENTS.instanceExited,
    ({ root }) => runtime.disconnect(root)
  )
  return () => {
    unlistenExit()
    unlistenNotification()
    unlistenRequest()
  }
}

export interface ManagedIdeBrokerEventTransport {
  subscribe<T>(event: string, handler: (payload: T) => void): () => void
}

/**
 * Headless equivalent of `attachManagedIdeBroker`. The brain receives broker
 * frames over the companion event stream and executes providers in its own
 * PluginManager; responses use the service-scoped companion transport.
 */
export function attachManagedIdeBrokerTransport(
  eventTransport: ManagedIdeBrokerEventTransport,
  runtime = new ManagedIdeBrokerRuntime()
): () => void {
  const unsubscribeRequest = eventTransport.subscribe<CodeServerBrokerRequest>(
    CODESERVER_EVENTS.brokerRequest,
    (request) => {
      void runtime.dispatch(request).then(
        (result) => codeServerClient.respondToBroker(request, { result }),
        (error) =>
          codeServerClient.respondToBroker(request, {
            error: toStructuredError(error),
          })
      )
    }
  )
  const unsubscribeNotification = eventTransport.subscribe<CodeServerBrokerNotification>(
    CODESERVER_EVENTS.brokerNotification,
    (notification) => runtime.cancel(notification)
  )
  const unsubscribeExit = eventTransport.subscribe<{ root: string }>(
    CODESERVER_EVENTS.instanceExited,
    ({ root }) => runtime.disconnect(root)
  )
  return () => {
    unsubscribeExit()
    unsubscribeNotification()
    unsubscribeRequest()
  }
}

export async function hashIdeManifest(manifest: unknown): Promise<string> {
  const encoded = new TextEncoder().encode(canonicalJson(manifest))
  const digest = await crypto.subtle.digest("SHA-256", encoded)
  return `sha256:${Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("")}`
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (value && typeof value === "object") {
    return `{${Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`
  }
  return JSON.stringify(value)
}

export function createManagedIdeBrokerDependencies(): ManagedIdeBrokerDependencies {
  const protocols = new ManagedProtocolRuntime()
  return {
    expectedHostId: "local",
    getPlugin: (pluginId) => usePluginStore.getState().plugins[pluginId],
    isWorkspaceTrusted,
    validatePaths: (root, paths) => codeServerClient.validateBrokerPaths(root, paths),
    createContent: (root, generation, pluginId, providerId, permission, bytes) =>
      codeServerClient.createBrokerContent(
        root,
        generation,
        pluginId,
        providerId,
        permission,
        "application/octet-stream",
        Array.from(bytes)
      ),
    redeemContent: async (root, generation, pluginId, providerId, permission, handleId) =>
      Uint8Array.from(
        await codeServerClient.redeemBrokerContent(
          root,
          generation,
          pluginId,
          providerId,
          permission,
          handleId
        )
      ),
    async authorize(pluginId, permission, reason) {
      const simulated = permissionSimulator?.({ pluginId, permission, reason })
      if (simulated !== undefined) return simulated
      const guard = getPermissionGuard()
      guard.require(pluginId, permission, reason)
      if (!CONTEXTUAL_PERMISSIONS.has(permission)) return true
      return getPluginConsentBroker().request({ pluginId, permission, reason })
    },
    requirePermission(pluginId, permission, reason) {
      getPermissionGuard().require(pluginId, permission, reason)
    },
    invoke: (pluginId, handler, args) =>
      getPluginManager().invokeIdeProvider(pluginId, handler, args),
    invokeAgent: async (agentId, prompt, context) => {
      const { dispatchSubagent } = await import("@/lib/plugin/agent-sdk/dispatch")
      const result = await dispatchSubagent(agentId, prompt, {
        abortSignal: context.signal,
        _onEvent: context.onEvent,
        _canUseTool: (toolName, input) => context.requestApproval(toolName, input),
      })
      return {
        result: { metadata: { runId: result.runId } },
      }
    },
    protocolStart: (input) => protocols.start(input),
    protocolRequest: (input) => protocols.request(input),
    protocolCancel: (input) => protocols.cancel(input),
    protocolDocument: (input) => protocols.document(input),
    protocolStop: (input) => protocols.stop(input),
    getUserId: () =>
      process.env.COGNIA_ACCOUNT_ID ??
      useAccountStore.getState().activeAccountId ??
      "local-default",
    stateGet: (pluginId, scope, key) =>
      invokePluginApi(pluginId, "managedIdeState:get", { scope, key }),
    stateSet: (pluginId, scope, key, value) =>
      invokePluginApi(pluginId, "managedIdeState:set", { scope, key, value }),
    stateDelete: (pluginId, scope, key) =>
      invokePluginApi(pluginId, "managedIdeState:delete", { scope, key }),
    stateKeys: (pluginId, scope) =>
      invokePluginApi<string[]>(pluginId, "managedIdeState:keys", { scope }),
    secretGet: (pluginId, scope, key) =>
      invokePluginApi<string | null>(pluginId, "managedIdeSecrets:get", { scope, key }),
    secretSet: (pluginId, scope, key, value) =>
      invokePluginApi(pluginId, "managedIdeSecrets:set", { scope, key, value }),
    secretDelete: (pluginId, scope, key) =>
      invokePluginApi(pluginId, "managedIdeSecrets:delete", { scope, key }),
    secretKeys: (pluginId, scope) =>
      invokePluginApi<string[]>(pluginId, "managedIdeSecrets:keys", { scope }),
    now: Date.now,
  }
}

function agentPrompt(args: unknown[]): string {
  const request = args[0]
  if (
    request &&
    typeof request === "object" &&
    typeof (request as { prompt?: unknown }).prompt === "string"
  ) {
    return (request as { prompt: string }).prompt
  }
  throw brokerError(-32602, "IDE_AGENT_PROMPT_INVALID")
}

function validateInvokeParams(value: unknown): ProviderInvokeParams {
  if (!value || typeof value !== "object") {
    throw brokerError(-32602, "IDE_PROVIDER_PARAMS_INVALID", "params")
  }
  const params = value as Partial<ProviderInvokeParams>
  const required = [
    "pluginId",
    "invocationId",
    "pluginVersion",
    "manifestHash",
    "catalogHash",
    "hostId",
    "workspaceRoot",
    "providerId",
    "providerKind",
    "handler",
    "operation",
  ] as const
  for (const key of required) {
    if (typeof params[key] !== "string" || params[key].length === 0) {
      throw brokerError(-32602, "IDE_PROVIDER_PARAMS_INVALID", key)
    }
  }
  if (typeof params.workspaceTrusted !== "boolean") {
    throw brokerError(-32602, "IDE_PROVIDER_PARAMS_INVALID", "workspaceTrusted")
  }
  if (!Array.isArray(params.arguments)) {
    throw brokerError(-32602, "IDE_PROVIDER_PARAMS_INVALID", "arguments")
  }
  return params as ProviderInvokeParams
}

function validateProtocolParams(value: unknown): ProtocolParams {
  if (!value || typeof value !== "object") {
    throw brokerError(-32602, "IDE_PROTOCOL_PARAMS_INVALID")
  }
  const params = value as Partial<ProtocolParams>
  for (const key of [
    "invocationId",
    "pluginId",
    "pluginVersion",
    "manifestHash",
    "catalogHash",
    "hostId",
    "workspaceRoot",
    "protocolId",
  ] as const) {
    if (typeof params[key] !== "string" || params[key].length === 0) {
      throw brokerError(-32602, "IDE_PROTOCOL_PARAMS_INVALID", key)
    }
  }
  if (!["lsp", "dap", "mcp"].includes(params.family ?? "")) {
    throw brokerError(-32602, "IDE_PROTOCOL_PARAMS_INVALID", "family")
  }
  if (typeof params.workspaceTrusted !== "boolean") {
    throw brokerError(-32602, "IDE_PROTOCOL_PARAMS_INVALID", "workspaceTrusted")
  }
  return params as ProtocolParams
}

function validateManagedIdeStateParams(method: string, value: unknown): ManagedIdeStateParams {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw brokerError(-32602, "IDE_STORAGE_PARAMS_INVALID")
  }
  const params = value as Partial<ManagedIdeStateParams>
  for (const key of [
    "pluginId",
    "pluginVersion",
    "manifestHash",
    "catalogHash",
    "hostId",
    "workspaceRoot",
  ] as const) {
    if (typeof params[key] !== "string" || params[key].length === 0) {
      throw brokerError(-32602, "IDE_STORAGE_PARAMS_INVALID", key)
    }
  }
  if (params.area !== "global" && params.area !== "workspace") {
    throw brokerError(-32602, "IDE_STORAGE_PARAMS_INVALID", "area")
  }
  if (typeof params.workspaceTrusted !== "boolean") {
    throw brokerError(-32602, "IDE_STORAGE_PARAMS_INVALID", "workspaceTrusted")
  }
  const operation = method.slice(method.lastIndexOf("/") + 1)
  if (!["get", "set", "delete", "keys"].includes(operation)) {
    throw brokerError(-32601, "IDE_BROKER_METHOD_NOT_FOUND", method)
  }
  if (operation !== "keys") {
    if (
      typeof params.key !== "string" ||
      params.key.length === 0 ||
      params.key.length > 1024 ||
      params.key.includes("\0")
    ) {
      throw brokerError(-32602, "IDE_STORAGE_KEY_INVALID")
    }
  }
  if (method === "cognia/secrets/set" && typeof params.value !== "string") {
    throw brokerError(-32602, "IDE_SECRET_VALUE_INVALID")
  }
  if (method === "cognia/state/set") {
    try {
      if (!Object.hasOwn(params, "value") || JSON.stringify(params.value) === undefined) {
        throw new Error("value is not JSON-serializable")
      }
    } catch {
      throw brokerError(-32602, "IDE_STORAGE_VALUE_INVALID")
    }
  }
  return params as ManagedIdeStateParams
}

function validateCancellationParams(
  value: unknown
): Pick<ProviderInvokeParams, "invocationId" | "pluginId" | "providerId" | "operation"> {
  if (!value || typeof value !== "object") {
    throw brokerError(-32602, "IDE_PROVIDER_CANCEL_PARAMS_INVALID")
  }
  const params = value as Record<string, unknown>
  for (const key of ["invocationId", "pluginId", "providerId", "operation"] as const) {
    if (typeof params[key] !== "string" || params[key].length === 0) {
      throw brokerError(-32602, "IDE_PROVIDER_CANCEL_PARAMS_INVALID", key)
    }
  }
  return params as Pick<
    ProviderInvokeParams,
    "invocationId" | "pluginId" | "providerId" | "operation"
  >
}

function validateApprovalResponseParams(value: unknown): {
  invocationId: string
  requestId: string
  pluginId: string
  providerId: string
  decision: "allow" | "deny"
  updatedInput?: Record<string, unknown>
  message?: string
} {
  if (!value || typeof value !== "object") {
    throw brokerError(-32602, "IDE_AGENT_APPROVAL_PARAMS_INVALID")
  }
  const params = value as Record<string, unknown>
  for (const key of ["invocationId", "requestId", "pluginId", "providerId"] as const) {
    if (typeof params[key] !== "string" || params[key].length === 0) {
      throw brokerError(-32602, "IDE_AGENT_APPROVAL_PARAMS_INVALID", key)
    }
  }
  if (params.decision !== "allow" && params.decision !== "deny") {
    throw brokerError(-32602, "IDE_AGENT_APPROVAL_PARAMS_INVALID", "decision")
  }
  if (
    params.updatedInput !== undefined &&
    (!params.updatedInput ||
      typeof params.updatedInput !== "object" ||
      Array.isArray(params.updatedInput))
  ) {
    throw brokerError(-32602, "IDE_AGENT_APPROVAL_PARAMS_INVALID", "updatedInput")
  }
  if (params.message !== undefined && typeof params.message !== "string") {
    throw brokerError(-32602, "IDE_AGENT_APPROVAL_PARAMS_INVALID", "message")
  }
  return params as {
    invocationId: string
    requestId: string
    pluginId: string
    providerId: string
    decision: "allow" | "deny"
    updatedInput?: Record<string, unknown>
    message?: string
  }
}

function validateProtocolCancellationParams(value: unknown): {
  invocationId: string
  pluginId: string
  protocolId: string
  consumerId?: string
} {
  if (!value || typeof value !== "object") {
    throw brokerError(-32602, "IDE_PROTOCOL_CANCEL_PARAMS_INVALID")
  }
  const params = value as Record<string, unknown>
  for (const key of ["invocationId", "pluginId", "protocolId"] as const) {
    if (typeof params[key] !== "string" || params[key].length === 0) {
      throw brokerError(-32602, "IDE_PROTOCOL_CANCEL_PARAMS_INVALID", key)
    }
  }
  if (params.consumerId !== undefined && typeof params.consumerId !== "string") {
    throw brokerError(-32602, "IDE_PROTOCOL_CANCEL_PARAMS_INVALID", "consumerId")
  }
  return params as {
    invocationId: string
    pluginId: string
    protocolId: string
    consumerId?: string
  }
}

function findProvider(
  providers: PluginIdeProviderDeclaration[],
  params: ProviderInvokeParams
): PluginIdeProviderDeclaration {
  const provider = providers.find((entry) => entry.id === params.providerId)
  if (
    !provider ||
    provider.kind !== params.providerKind ||
    provider.handler !== params.handler ||
    (provider.permission ?? null) !== params.permission
  ) {
    throw brokerError(-32004, "IDE_PROVIDER_NOT_DECLARED", params.providerId)
  }
  if (!IDE_PROVIDER_CATALOG.has(provider.kind)) {
    throw brokerError(-32004, "IDE_PROVIDER_UNCLASSIFIED", provider.kind)
  }
  return provider
}

function collectHostPaths(value: unknown): string[] {
  const paths = new Set<string>()

  const visit = (entry: unknown, key?: string): void => {
    if (typeof entry === "string") {
      if (key === "uri" && entry.startsWith("file:")) {
        let uri: URL
        try {
          uri = new URL(entry)
        } catch {
          throw brokerError(-32602, "IDE_FILE_URI_INVALID", entry)
        }
        if (uri.protocol !== "file:" || uri.host !== "") {
          throw brokerError(-32602, "IDE_FILE_URI_INVALID", entry)
        }
        paths.add(decodeURIComponent(uri.pathname))
        return
      }
      if (key === "path" || key === "fsPath" || key === "cwd") {
        if (!entry.startsWith("/")) {
          throw brokerError(-32602, "IDE_HOST_PATH_NOT_ABSOLUTE", entry)
        }
        paths.add(entry)
      }
      return
    }
    if (Array.isArray(entry)) {
      entry.forEach((item) => visit(item))
      return
    }
    if (!entry || typeof entry !== "object") return

    const record = entry as Record<string, unknown>
    if (record.scheme === "file" && typeof record.path === "string") {
      if (!record.path.startsWith("/")) {
        throw brokerError(-32602, "IDE_HOST_PATH_NOT_ABSOLUTE", record.path)
      }
      paths.add(record.path)
    }
    for (const [childKey, child] of Object.entries(record)) {
      visit(child, childKey)
    }
  }

  visit(value)
  return [...paths].sort()
}

async function transformContentHandles(
  value: unknown,
  operations: {
    encode?: (bytes: Uint8Array) => Promise<unknown>
    decode?: (handleId: string) => Promise<Uint8Array>
  },
  seen = new WeakSet<object>()
): Promise<unknown> {
  if (value instanceof Uint8Array) {
    if (!operations.encode) return value
    return operations.encode(value)
  }
  if (!value || typeof value !== "object") return value
  if (operations.decode && (value as { $type?: unknown }).$type === "ContentHandle") {
    const handleId = (value as { id?: unknown }).id
    if (typeof handleId !== "string" || handleId.length === 0) {
      throw brokerError(-32602, "IDE_CONTENT_HANDLE_INVALID")
    }
    return operations.decode(handleId)
  }
  if (seen.has(value)) {
    throw brokerError(-32602, "IDE_PROVIDER_VALUE_CYCLIC")
  }
  seen.add(value)
  if (Array.isArray(value)) {
    return Promise.all(value.map((entry) => transformContentHandles(entry, operations, seen)))
  }
  return Object.fromEntries(
    await Promise.all(
      Object.entries(value).map(async ([key, entry]) => [
        key,
        await transformContentHandles(entry, operations, seen),
      ])
    )
  )
}

class ProviderScheduler {
  private reads = 0
  private readonly readWaiters: Array<() => void> = []
  private readonly writes = new Map<string, Promise<unknown>>()

  constructor(private readonly maxReads: number) {}

  async run<T>(key: string, write: boolean, operation: () => Promise<T>): Promise<T> {
    if (write) {
      const previous = this.writes.get(key) ?? Promise.resolve()
      const current = previous.catch(() => undefined).then(operation)
      this.writes.set(key, current)
      try {
        return await current
      } finally {
        if (this.writes.get(key) === current) this.writes.delete(key)
      }
    }
    if (this.reads >= this.maxReads) {
      await new Promise<void>((resolve) => this.readWaiters.push(resolve))
    }
    this.reads += 1
    try {
      return await operation()
    } finally {
      this.reads -= 1
      this.readWaiters.shift()?.()
    }
  }
}

async function withDeadline<T>(
  promise: Promise<T>,
  timeoutMs: number,
  signal: AbortSignal
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  let onAbort: (() => void) | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(brokerError(-32008, "IDE_PROVIDER_TIMEOUT", String(timeoutMs))),
          timeoutMs
        )
      }),
      new Promise<never>((_, reject) => {
        onAbort = () => reject(signal.reason ?? brokerError(-32800, "IDE_PROVIDER_CANCELLED"))
        if (signal.aborted) onAbort()
        else signal.addEventListener("abort", onAbort, { once: true })
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
    if (onAbort) signal.removeEventListener("abort", onAbort)
  }
}

async function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  let onAbort: (() => void) | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        onAbort = () => reject(signal.reason ?? brokerError(-32800, "IDE_REQUEST_CANCELLED"))
        if (signal.aborted) onAbort()
        else signal.addEventListener("abort", onAbort, { once: true })
      }),
    ])
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort)
  }
}

function isCancellationError(error: unknown): boolean {
  return Boolean(
    error && typeof error === "object" && (error as { code?: unknown }).code === -32800
  )
}

function brokerError(code: number, message: string, data?: unknown): Error {
  return Object.assign(new Error(message), { code, data })
}

function toStructuredError(error: unknown): {
  code: number
  message: string
  data?: unknown
} {
  if (error && typeof error === "object") {
    const value = error as { code?: unknown; message?: unknown; data?: unknown }
    return {
      code: typeof value.code === "number" ? value.code : -32603,
      message: typeof value.message === "string" ? value.message : "Managed IDE provider failed",
      ...(value.data === undefined ? {} : { data: value.data }),
    }
  }
  return { code: -32603, message: String(error) }
}
