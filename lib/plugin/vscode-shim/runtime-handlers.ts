/**
 * Host-neutral VS Code RPC adapters.
 *
 * These handlers deliberately reuse Cognia's canonical registries and secret
 * store. Methods that have no renderer-independent Cognia capability are
 * still registered, but fail with an explicit capability error instead of
 * leaving the extension host parked until its 30-second RPC timeout.
 */

import {
  executeCommand,
  getCommands,
  registerCommand,
  unregisterCommand,
  unregisterCommandsByPlugin,
} from "@/lib/plugin/commands/registry"
import {
  executeTask,
  fetchTasks,
  registerTaskProvider,
  unregisterProvidersByPlugin,
  unregisterTaskProvider,
  type ResolvedTask,
} from "@/lib/plugin/commands/tasks-registry"
import {
  getProvider,
  getSession,
  registerAuthenticationProvider,
  unregisterAuthenticationProvider,
  unregisterProvidersByPlugin as unregisterAuthProvidersByPlugin,
  type AuthSessionOptions,
} from "@/lib/plugin/auth/auth-provider-registry"
import { createKeyringStore } from "@/lib/credentials/keyring-store"
import { listPluginPermissions } from "@/lib/plugin/core/transport"
import { registerMethod, type RpcContext } from "./rpc-dispatcher"

type InvokeSidecar = (pluginId: string, method: string, payload: unknown) => Promise<unknown>

let invokeSidecar: InvokeSidecar = async (pluginId, method, payload) => {
  const { invokeVscodeRpc } = await import("@/lib/plugin/core/vscode-loader")
  return invokeVscodeRpc(pluginId, method, payload)
}

/** Test-only dependency override. */
export function configureVscodeRuntimeHandlersForTesting(impl: InvokeSidecar | null): void {
  invokeSidecar =
    impl ??
    (async (pluginId, method, payload) => {
      const { invokeVscodeRpc } = await import("@/lib/plugin/core/vscode-loader")
      return invokeVscodeRpc(pluginId, method, payload)
    })
}

function payloadObject(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("VS Code RPC payload must be an object")
  }
  return payload as Record<string, unknown>
}

function ownedPayload(payload: unknown, context: RpcContext): Record<string, unknown> {
  const value = payloadObject(payload)
  const extensionId = value.extensionId
  if (extensionId !== undefined && extensionId !== context.pluginId) {
    throw new Error(
      `VS Code RPC extension ownership mismatch: ${String(extensionId)} != ${context.pluginId}`
    )
  }
  return value
}

function requiredString(value: Record<string, unknown>, field: string): string {
  const result = value[field]
  if (typeof result !== "string" || !result) {
    throw new Error(`VS Code RPC payload requires non-empty ${field}`)
  }
  return result
}

async function requirePermission(pluginId: string, permission: string): Promise<void> {
  const grants = await listPluginPermissions(pluginId)
  if (!grants.includes(permission)) {
    throw new Error(`VS Code extension ${pluginId} requires permission ${permission}`)
  }
}

const commandDisposers = new Map<string, () => void>()

function commandKey(pluginId: string, command: string): string {
  return `${pluginId}::${command}`
}

const providerDisposers = new Map<string, () => void>()

function providerKey(pluginId: string, type: string): string {
  return `${pluginId}::${type}`
}

/**
 * Every outbound request/notification currently exposed by the sidecar but
 * lacking a canonical host-neutral adapter. Registering these is intentional:
 * requests receive a deterministic JSON-RPC capability error immediately and
 * notifications are logged by the dispatcher rather than disappearing as
 * "method not found" noise.
 */
export const EXPLICITLY_UNAVAILABLE_VSCODE_RPC_METHODS = [
  "env:asExternalUri",
  "env:clipboardReadText",
  "env:clipboardWriteText",
  "env:openExternal",
  "extensions:activate",
  "extensions:get",
  "fs:copy",
  "fs:createDirectory",
  "fs:delete",
  "fs:readDirectory",
  "fs:readFile",
  "fs:rename",
  "fs:stat",
  "fs:writeFile",
  "languages:getDiagnostics",
  "languages:setLanguageConfiguration",
  "languages:setTextDocumentLanguage",
  "terminal:create",
  "terminal:dispose",
  "terminal:hide",
  "terminal:sendText",
  "terminal:show",
  "webview:dispose",
  "webview:postMessage",
  "webview:reveal",
  "webview:setHtml",
  "webview:setTitle",
  "webview:show",
  "window:clearStatusBarMessage",
  "window:createOutputChannel",
  "window:createStatusBarItem",
  "window:createWebviewPanel",
  "window:disposeDecorationType",
  "window:disposeStatusBarItem",
  "window:hideStatusBarItem",
  "window:outputChannelAppend",
  "window:outputChannelClear",
  "window:outputChannelDispose",
  "window:outputChannelHide",
  "window:outputChannelShow",
  "window:progressEnd",
  "window:progressReport",
  "window:progressStart",
  "window:registerDecorationType",
  "window:registerUriHandler",
  "window:registerWebviewViewProvider",
  "window:setStatusBarMessage",
  "window:setStatusBarText",
  "window:setStatusBarTooltip",
  "window:showInputBox",
  "window:showMessage",
  "window:showOpenDialog",
  "window:showQuickPick",
  "window:showSaveDialog",
  "window:showStatusBarItem",
  "window:unregisterUriHandler",
  "window:unregisterWebviewViewProvider",
  "workspace:applyEdit",
  "workspace:configurationGet",
  "workspace:configurationHas",
  "workspace:configurationInspect",
  "workspace:configurationUpdate",
  "workspace:createFileSystemWatcher",
  "workspace:disposeFileSystemWatcher",
  "workspace:findFiles",
  "workspace:openTextDocument",
  "workspace:registerTextDocumentContentProvider",
  "workspace:unregisterTextDocumentContentProvider",
] as const

export function installVscodeRuntimeRpcHandlers(): Array<() => void> {
  const disposers: Array<() => void> = []

  disposers.push(
    registerMethod("commands:register", (payload, context) => {
      const value = ownedPayload(payload, context)
      const command = requiredString(value, "command")
      const token = requiredString(value, "token")
      const key = commandKey(context.pluginId, command)
      commandDisposers.get(key)?.()
      const dispose = registerCommand({
        id: command,
        pluginId: context.pluginId,
        handler: (...args) =>
          invokeSidecar(context.pluginId, "extension:call", { token, payload: args }),
      })
      commandDisposers.set(key, dispose)
      return { registered: true }
    })
  )
  disposers.push(
    registerMethod("commands:unregister", (payload, context) => {
      const value = ownedPayload(payload, context)
      const command = requiredString(value, "command")
      commandDisposers.get(commandKey(context.pluginId, command))?.()
      commandDisposers.delete(commandKey(context.pluginId, command))
      unregisterCommand(command)
    })
  )
  disposers.push(
    registerMethod("commands:execute", (payload, context) => {
      const value = ownedPayload(payload, context)
      const args = Array.isArray(value.args) ? value.args : []
      return executeCommand(requiredString(value, "command"), ...args)
    })
  )
  disposers.push(
    registerMethod("commands:list", (payload) => {
      const value = payloadObject(payload)
      return getCommands(value.filterInternal === true)
    })
  )

  disposers.push(
    registerMethod("secrets:get", async (payload, context) => {
      const value = ownedPayload(payload, context)
      await requirePermission(context.pluginId, "secrets:read")
      return (
        (await createKeyringStore(`plugin:${context.pluginId}`).load(
          requiredString(value, "key")
        )) ?? null
      )
    })
  )
  disposers.push(
    registerMethod("secrets:store", async (payload, context) => {
      const value = ownedPayload(payload, context)
      await requirePermission(context.pluginId, "secrets:write")
      await createKeyringStore(`plugin:${context.pluginId}`).save(
        requiredString(value, "key"),
        requiredString(value, "value")
      )
    })
  )
  disposers.push(
    registerMethod("secrets:delete", async (payload, context) => {
      const value = ownedPayload(payload, context)
      await requirePermission(context.pluginId, "secrets:write")
      await createKeyringStore(`plugin:${context.pluginId}`).delete(requiredString(value, "key"))
    })
  )

  disposers.push(
    registerMethod("tasks:registerProvider", (payload, context) => {
      const value = ownedPayload(payload, context)
      const type = requiredString(value, "type")
      const tokens = payloadObject(value.tokens)
      const provideToken = requiredString(tokens, "provideTasks")
      const key = providerKey(context.pluginId, type)
      providerDisposers.get(key)?.()
      const dispose = registerTaskProvider({
        type,
        pluginId: context.pluginId,
        provideTasks: async () =>
          (await invokeSidecar(context.pluginId, "extension:call", {
            token: provideToken,
            payload: { filter: { type } },
          })) as ResolvedTask[],
      })
      providerDisposers.set(key, dispose)
      return { registered: true }
    })
  )
  disposers.push(
    registerMethod("tasks:unregisterProvider", (payload, context) => {
      const value = ownedPayload(payload, context)
      const type = requiredString(value, "type")
      providerDisposers.get(providerKey(context.pluginId, type))?.()
      providerDisposers.delete(providerKey(context.pluginId, type))
      unregisterTaskProvider(type, context.pluginId)
    })
  )
  disposers.push(
    registerMethod("tasks:fetchTasks", (payload) => {
      const value = payloadObject(payload)
      return fetchTasks(
        value.filter && typeof value.filter === "object"
          ? (value.filter as { type?: string })
          : undefined
      )
    })
  )
  disposers.push(
    registerMethod("tasks:executeTask", async (payload) => {
      const execution = await executeTask(payloadObject(payload).task as unknown as ResolvedTask)
      const task = payloadObject(payload).task as unknown as ResolvedTask
      return { taskId: task.id, started: true, cancellable: typeof execution.cancel === "function" }
    })
  )

  disposers.push(
    registerMethod("authentication:registerProvider", async (payload, context) => {
      const value = ownedPayload(payload, context)
      await requirePermission(context.pluginId, "secrets:write")
      const providerId = requiredString(value, "providerId")
      const tokens = payloadObject(value.tokens)
      registerAuthenticationProvider({
        id: providerId,
        label: typeof value.label === "string" && value.label ? value.label : providerId,
        pluginId: context.pluginId,
        getSessions: (scopes) =>
          invokeSidecar(context.pluginId, "extension:call", {
            token: requiredString(tokens, "getSessions"),
            payload: { scopes },
          }) as Promise<never>,
        createSession: (scopes) =>
          invokeSidecar(context.pluginId, "extension:call", {
            token: requiredString(tokens, "createSession"),
            payload: { scopes },
          }) as Promise<never>,
        removeSession: (sessionId) =>
          invokeSidecar(context.pluginId, "extension:call", {
            token: requiredString(tokens, "removeSession"),
            payload: { sessionId },
          }) as Promise<void>,
      })
      return { registered: true }
    })
  )
  disposers.push(
    registerMethod("authentication:unregisterProvider", (payload, context) => {
      const value = ownedPayload(payload, context)
      const providerId = requiredString(value, "providerId")
      const provider = getProvider(providerId)
      if (provider?.pluginId === context.pluginId) unregisterAuthenticationProvider(providerId)
    })
  )
  disposers.push(
    registerMethod("authentication:getSession", async (payload, context) => {
      const value = ownedPayload(payload, context)
      await requirePermission(context.pluginId, "secrets:read")
      return getSession(
        requiredString(value, "providerId"),
        Array.isArray(value.scopes) ? (value.scopes as string[]) : [],
        (value.options ?? {}) as AuthSessionOptions
      )
    })
  )
  disposers.push(
    registerMethod("authentication:getAccounts", async (payload, context) => {
      const value = ownedPayload(payload, context)
      await requirePermission(context.pluginId, "secrets:read")
      const provider = getProvider(requiredString(value, "providerId"))
      if (!provider) return []
      const sessions = await provider.getSessions(undefined, { silent: true })
      return sessions.map((session) => session.account)
    })
  )

  for (const method of EXPLICITLY_UNAVAILABLE_VSCODE_RPC_METHODS) {
    disposers.push(
      registerMethod(method, (_payload, _context) => {
        throw new Error(
          `VS Code RPC ${method} is unavailable on this host: no canonical headless Cognia capability adapter is registered`
        )
      })
    )
  }
  return disposers
}

export function cleanupVscodeRuntimeRegistrations(pluginId: string): void {
  unregisterCommandsByPlugin(pluginId)
  unregisterProvidersByPlugin(pluginId)
  unregisterAuthProvidersByPlugin(pluginId)
  for (const key of [...commandDisposers.keys()]) {
    if (key.startsWith(`${pluginId}::`)) commandDisposers.delete(key)
  }
  for (const key of [...providerDisposers.keys()]) {
    if (key.startsWith(`${pluginId}::`)) providerDisposers.delete(key)
  }
}
