import type { CodeServerProxyArtifact } from "@/lib/codeserver/client"
import { codeServerClient } from "@/lib/codeserver/client"
import { ensureEditorLspRuntime } from "@/lib/lsp/ensure-editor-lsp-runtime"
import { invokeVscodeRpc } from "@/lib/plugin/core/vscode-loader"
import {
  LSP_TAURI_CHANNEL_ID,
  TauriLspClientAdapter,
  type LspDetectResultEntry,
} from "@/lib/plugin/lsp/lsp-client-adapter-tauri"
import { registerMethod } from "@/lib/plugin/vscode-shim/rpc-dispatcher"
import { transport } from "@/lib/tauri"
import { isRemoteHostActive } from "@/lib/tauri/transport-routing"
import { useSettingsStore } from "@/stores/settings"
import type {
  PluginIdeExecutableResource,
  PluginIdeProtocolServer,
} from "@/types/plugin/plugin-ide"

export type ManagedProtocolFamily = "lsp" | "dap" | "mcp"

export interface ManagedProtocolStart {
  root: string
  generation: number
  pluginId: string
  pluginVersion: string
  manifestHash: string
  consumerId?: string
  family: ManagedProtocolFamily
  server: PluginIdeProtocolServer
  executable: PluginIdeExecutableResource
}

export interface ManagedProtocolRequest {
  root: string
  generation: number
  pluginId: string
  family: ManagedProtocolFamily
  protocolId: string
  consumerId?: string
  method: string
  payload: unknown
  invocationId: string
}

interface LspAdapter {
  start(
    input: Parameters<TauriLspClientAdapter["start"]>[0]
  ): Promise<{ capabilities?: unknown } | void>
  stop(ownerId: string, serverId: string): Promise<void>
  request(input: Parameters<TauriLspClientAdapter["request"]>[0]): Promise<unknown>
  didOpen(input: Parameters<TauriLspClientAdapter["didOpen"]>[0]): Promise<void>
  didChange(input: Parameters<TauriLspClientAdapter["didChange"]>[0]): Promise<void>
  didClose(input: Parameters<TauriLspClientAdapter["didClose"]>[0]): Promise<void>
  serverResponse(input: Parameters<TauriLspClientAdapter["serverResponse"]>[0]): Promise<boolean>
  clientNotification(
    input: Parameters<TauriLspClientAdapter["clientNotification"]>[0]
  ): Promise<boolean>
  detect(input: Parameters<TauriLspClientAdapter["detect"]>[0]): Promise<LspDetectResultEntry[]>
}

export interface ManagedProtocolRuntimeDependencies {
  listProxies(): Promise<CodeServerProxyArtifact[]>
  ensureHost(): Promise<void>
  createLspAdapter(): LspAdapter
  notify(
    root: string,
    generation: number,
    params: {
      pluginId: string
      providerId: string
      consumerId?: string
      event: string
      payload?: unknown
    }
  ): Promise<void>
  invokeHost(method: string, payload: unknown): Promise<unknown>
  onHostMessage(listener: (method: string, params: unknown) => void): () => void
  readSetting(path: string): unknown
}

interface Session {
  family: ManagedProtocolFamily
  ownerId: string
  serverId: string
  root: string
  generation: number
  pluginId: string
  consumerId?: string
}

export class ManagedProtocolRuntime {
  private readonly sessions = new Map<string, Session>()
  private readonly lsp: LspAdapter
  private removeHostMessageListener: (() => void) | null

  constructor(
    private readonly dependencies: ManagedProtocolRuntimeDependencies = defaultDependencies()
  ) {
    this.lsp = dependencies.createLspAdapter()
    this.removeHostMessageListener = dependencies.onHostMessage((method, params) =>
      this.onHostMessage(method, params)
    )
  }

  async start(input: ManagedProtocolStart): Promise<{
    sessionId: string
    connection?: { endpoint?: string; headers?: Record<string, string>; capabilities?: unknown }
  }> {
    await this.dependencies.ensureHost()
    const command = await this.resolveExecutable(input)
    const sessionId = sessionKey(input)
    const ownerId = `managed-pro:${input.pluginId}:${input.root}${input.consumerId ? `:${input.consumerId}` : ""}`
    await this.stopOlderGenerations(input.root, input.pluginId, input.generation)
    if (this.sessions.has(sessionId)) return { sessionId }
    let connection:
      | {
          state?: unknown
          endpoint?: string
          headers?: Record<string, string>
          capabilities?: unknown
        }
      | undefined
    if (input.family === "lsp") {
      const lspStart = await this.lsp.start({
        ownerId,
        serverId: input.server.id,
        config: {
          id: input.server.id,
          name: input.server.id,
          languages: [...(input.server.languages ?? [])],
          command,
          args: [...(input.executable.args ?? [])],
          env: {},
          transport: input.server.transport as "stdio" | "socket",
          endpoint: input.server.endpoint,
          initializationOptions: input.server.initializationOptions as
            Record<string, unknown> | undefined,
          startupTimeout: input.executable.timeoutMs,
          memoryLimitMb: input.executable.memoryLimitMb,
        },
        workspaceFolders: [{ uri: pathToFileUri(input.root), name: workspaceName(input.root) }],
        onDiagnostics: (uri, markers) => {
          void this.dependencies.notify(input.root, input.generation, {
            pluginId: input.pluginId,
            providerId: input.server.id,
            consumerId: input.consumerId,
            event: "diagnostics",
            payload: { uri, diagnostics: markers },
          })
        },
        onServerRequest: (event) => {
          void this.dependencies.notify(input.root, input.generation, {
            pluginId: input.pluginId,
            providerId: input.server.id,
            consumerId: input.consumerId,
            event: "serverRequest",
            payload: event,
          })
        },
        onServerNotification: (event) => {
          void this.dependencies.notify(input.root, input.generation, {
            pluginId: input.pluginId,
            providerId: input.server.id,
            consumerId: input.consumerId,
            event: "serverNotification",
            payload: event,
          })
        },
      })
      if (lspStart && lspStart.capabilities !== undefined) {
        connection = { capabilities: lspStart.capabilities }
      }
    } else {
      connection = (await this.dependencies.invokeHost("protocol:start", {
        ownerId,
        serverId: input.server.id,
        family: input.family,
        command,
        args: [...(input.executable.args ?? [])],
        cwd: input.root,
        env: {},
        allowedEnvironment: [...(input.executable.allowedEnvironment ?? [])],
        transport: input.server.transport,
        endpoint: input.server.endpoint,
        startupTimeoutMs: input.executable.timeoutMs,
        memoryLimitMb: input.executable.memoryLimitMb,
      })) as typeof connection
    }
    this.sessions.set(sessionId, {
      family: input.family,
      ownerId,
      serverId: input.server.id,
      root: input.root,
      generation: input.generation,
      pluginId: input.pluginId,
      consumerId: input.consumerId,
    })
    return {
      sessionId,
      ...(connection
        ? {
            connection: {
              endpoint: connection.endpoint,
              headers: connection.headers,
              capabilities: connection.capabilities,
            },
          }
        : {}),
    }
  }

  async request(input: ManagedProtocolRequest): Promise<unknown> {
    const session = this.sessions.get(
      sessionKey({
        root: input.root,
        generation: input.generation,
        pluginId: input.pluginId,
        server: { id: input.protocolId },
        consumerId: input.consumerId,
      })
    )
    if (!session || session.family !== input.family) {
      throw protocolError("IDE_PROTOCOL_SESSION_NOT_RUNNING", input.protocolId)
    }
    if (
      input.family === "lsp" &&
      (input.method === "$/cognia/authorizeServerRequest" ||
        input.method === "$/cognia/serverResponse" ||
        input.method === "$/cognia/clientNotification")
    ) {
      const payload = input.payload as {
        requestId?: unknown
        result?: unknown
        error?: { code: number; message: string; data?: unknown }
      }
      if (input.method !== "$/cognia/clientNotification" && typeof payload.requestId !== "string") {
        throw protocolError("IDE_LSP_SERVER_REQUEST_ID_REQUIRED", input.protocolId)
      }
      if (input.method === "$/cognia/authorizeServerRequest") {
        return { authorized: true }
      }
      if (input.method === "$/cognia/clientNotification") {
        const notification = input.payload as {
          requestId?: unknown
          method?: unknown
          payload?: unknown
        }
        if (typeof notification.method !== "string") {
          throw protocolError("IDE_LSP_CLIENT_NOTIFICATION_METHOD_REQUIRED", input.protocolId)
        }
        return {
          accepted: await this.lsp.clientNotification({
            ownerId: session.ownerId,
            serverId: session.serverId,
            method: notification.method,
            payload: notification.payload,
          }),
        }
      }
      if (typeof payload.requestId !== "string") {
        throw protocolError("IDE_LSP_SERVER_REQUEST_ID_REQUIRED", input.protocolId)
      }
      return {
        accepted: await this.lsp.serverResponse({
          ownerId: session.ownerId,
          serverId: session.serverId,
          requestId: payload.requestId,
          result: payload.result,
          error: payload.error,
        }),
      }
    }
    if (input.family !== "lsp") {
      return this.dependencies.invokeHost("protocol:request", {
        ownerId: session.ownerId,
        serverId: session.serverId,
        message: input.payload,
        requestId: input.invocationId,
      })
    }
    return this.lsp.request({
      ownerId: session.ownerId,
      serverId: session.serverId,
      method: input.method,
      payload: input.payload,
      requestId: input.invocationId,
    })
  }

  async cancel(input: {
    root: string
    generation: number
    pluginId: string
    protocolId: string
    consumerId?: string
    invocationId: string
  }): Promise<boolean> {
    const session = this.sessions.get(
      sessionKey({
        root: input.root,
        generation: input.generation,
        pluginId: input.pluginId,
        server: { id: input.protocolId },
        consumerId: input.consumerId,
      })
    )
    if (!session) return false
    const result = (await this.dependencies.invokeHost(
      session.family === "lsp" ? "lsp:cancel" : "protocol:cancel",
      {
        ownerId: session.ownerId,
        serverId: session.serverId,
        requestId: input.invocationId,
      }
    )) as { cancelled?: unknown }
    return result.cancelled === true
  }

  async document(
    input: Omit<ManagedProtocolRequest, "method" | "payload" | "invocationId"> & {
      operation: "open" | "change" | "close"
      uri: string
      languageId?: string
      text?: string
    }
  ): Promise<void> {
    const session = this.sessions.get(
      sessionKey({
        root: input.root,
        generation: input.generation,
        pluginId: input.pluginId,
        server: { id: input.protocolId },
        consumerId: input.consumerId,
      })
    )
    if (!session || session.family !== "lsp") {
      throw protocolError("IDE_PROTOCOL_SESSION_NOT_RUNNING", input.protocolId)
    }
    const base = {
      ownerId: session.ownerId,
      serverId: session.serverId,
      uri: input.uri,
    }
    if (input.operation === "close") {
      await this.lsp.didClose(base)
    } else if (input.operation === "open") {
      if (typeof input.text !== "string" || typeof input.languageId !== "string") {
        throw protocolError("IDE_LSP_DOCUMENT_INVALID", input.uri)
      }
      await this.lsp.didOpen({ ...base, languageId: input.languageId, text: input.text })
    } else {
      if (typeof input.text !== "string") {
        throw protocolError("IDE_LSP_DOCUMENT_INVALID", input.uri)
      }
      await this.lsp.didChange({ ...base, text: input.text })
    }
  }

  async stop(input: {
    root: string
    generation: number
    pluginId: string
    protocolId: string
    consumerId?: string
  }): Promise<void> {
    const key = sessionKey({
      root: input.root,
      generation: input.generation,
      pluginId: input.pluginId,
      server: { id: input.protocolId },
      consumerId: input.consumerId,
    })
    const session = this.sessions.get(key)
    if (!session) return
    this.sessions.delete(key)
    if (session.family === "lsp") {
      await this.lsp.stop(session.ownerId, session.serverId)
    } else {
      await this.dependencies.invokeHost("protocol:stop", {
        ownerId: session.ownerId,
        serverId: session.serverId,
      })
    }
  }

  async dispose(): Promise<void> {
    const sessions = [...this.sessions.values()]
    this.sessions.clear()
    for (const session of sessions) {
      if (session.family === "lsp") {
        await this.lsp.stop(session.ownerId, session.serverId)
      } else {
        await this.dependencies.invokeHost("protocol:stop", {
          ownerId: session.ownerId,
          serverId: session.serverId,
        })
      }
    }
    this.removeHostMessageListener?.()
    this.removeHostMessageListener = null
  }

  private async resolveExecutable(input: ManagedProtocolStart): Promise<string> {
    const source = input.executable.source
    if (source.kind === "plugin-resource") {
      const artifacts = await this.dependencies.listProxies()
      const artifact = artifacts.find(
        (entry) =>
          entry.pluginId === input.pluginId &&
          entry.pluginVersion === input.pluginVersion &&
          entry.manifestHash === input.manifestHash &&
          entry.platformVersion === "1.0.0"
      )
      const executable = artifact?.executables.find(
        (entry) => entry.id === input.executable.id && entry.sha256 === source.sha256
      )
      if (!executable) {
        throw protocolError("IDE_EXECUTABLE_ARTIFACT_NOT_VERIFIED", input.executable.id)
      }
      return executable.path
    }
    if (source.kind === "registered-tool") {
      const [detected] = await this.lsp.detect({
        servers: [{ serverId: input.server.id, command: source.tool }],
        projectRoot: input.root,
      })
      if (!detected?.resolvedPath) {
        throw protocolError("IDE_REGISTERED_TOOL_NOT_FOUND", source.tool)
      }
      return detected.resolvedPath
    }
    const selected = this.dependencies.readSetting(source.setting)
    if (typeof selected !== "string" || !selected.startsWith("/")) {
      throw protocolError("IDE_USER_EXECUTABLE_NOT_SELECTED", source.setting)
    }
    return selected
  }

  private async stopOlderGenerations(
    root: string,
    pluginId: string,
    generation: number
  ): Promise<void> {
    const prefix = `${root}\0${pluginId}\0`
    for (const [key, session] of [...this.sessions]) {
      if (!key.startsWith(prefix) || key.startsWith(`${prefix}${generation}\0`)) continue
      this.sessions.delete(key)
      if (session.family === "lsp") {
        await this.lsp.stop(session.ownerId, session.serverId)
      } else {
        await this.dependencies.invokeHost("protocol:stop", {
          ownerId: session.ownerId,
          serverId: session.serverId,
        })
      }
    }
  }

  private onHostMessage(method: string, params: unknown): void {
    if (!["protocol:message", "protocol:state"].includes(method)) return
    const value = params as { ownerId?: unknown; serverId?: unknown }
    if (typeof value.ownerId !== "string" || typeof value.serverId !== "string") return
    const session = [...this.sessions.values()].find(
      (entry) => entry.ownerId === value.ownerId && entry.serverId === value.serverId
    )
    if (!session) return
    void this.dependencies.notify(session.root, session.generation, {
      pluginId: session.pluginId,
      providerId: session.serverId,
      consumerId: session.consumerId,
      event: method === "protocol:message" ? "message" : "state",
      payload: params,
    })
  }
}

function defaultDependencies(): ManagedProtocolRuntimeDependencies {
  return {
    listProxies: () => codeServerClient.listProxies(),
    ensureHost: () => ensureEditorLspRuntime(),
    createLspAdapter: () => new TauriLspClientAdapter(),
    notify: (root, generation, params) => codeServerClient.notifyBroker(root, generation, params),
    invokeHost: invokeManagedProtocolHost,
    onHostMessage: (listener) => {
      const removeMessage = registerMethod("protocol:message", (params) =>
        listener("protocol:message", params)
      )
      const removeState = registerMethod("protocol:state", (params) =>
        listener("protocol:state", params)
      )
      return () => {
        removeState()
        removeMessage()
      }
    },
    readSetting: (path) => readDotted(useSettingsStore.getState().settings, path),
  }
}

async function invokeManagedProtocolHost(method: string, payload: unknown): Promise<unknown> {
  if (!isRemoteHostActive()) return invokeVscodeRpc(LSP_TAURI_CHANNEL_ID, method, payload)
  const raw = await transport.call<string>("lsp_host_request", {
    method,
    payloadJson: JSON.stringify(payload ?? null),
  })
  return raw ? JSON.parse(raw) : null
}

function sessionKey(input: {
  root: string
  generation: number
  pluginId: string
  server: Pick<PluginIdeProtocolServer, "id">
  consumerId?: string
}): string {
  return `${input.root}\0${input.pluginId}\0${input.generation}\0${input.server.id}\0${input.consumerId ?? "shared"}`
}

function readDotted(value: unknown, path: string): unknown {
  let cursor = value
  for (const segment of path.split(".")) {
    if (!cursor || typeof cursor !== "object" || Array.isArray(cursor)) return undefined
    cursor = (cursor as Record<string, unknown>)[segment]
  }
  return cursor
}

function pathToFileUri(path: string): string {
  return `file://${path
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/")}`
}

function workspaceName(path: string): string {
  return path.split("/").filter(Boolean).at(-1) ?? "workspace"
}

function protocolError(code: string, detail?: string): Error {
  const error = new Error(detail ? `${code}: ${detail}` : code) as Error & { code: string }
  error.code = code
  return error
}
