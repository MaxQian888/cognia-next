/**
 * Renderer side of `vscode.extensions`.
 *
 *   - `extensions:changed` tells each host the installed VS Code extensions
 *     (id, install directory, whether running), before its extension
 *     activates and whenever that list changes; the host reads each one's
 *     `package.json` from the directory.
 *   - `extensions:activate` is `Extension.activate()` on another extension:
 *     one already running answers at once, a suspended one is resumed, one
 *     starting is waited for. One the user disabled stays disabled and the
 *     call fails, as the user's choice wins over an extension's.
 */

import { usePluginStore } from "@/stores/plugin-runtime"
import type { PluginStatus } from "@/types/plugin/plugin"

import { registerMethod, type RpcContext } from "./rpc-dispatcher"

/** How long `activate()` waits for an extension that is starting. */
export const ACTIVATION_WAIT_MS = 30_000

export interface InstalledVscodeExtension {
  id: string
  path: string
  status: PluginStatus
}

export interface VscodeExtensionsDependencies {
  extensions(): InstalledVscodeExtension[]
  subscribe(listener: () => void): () => void
  resume(id: string): Promise<void>
  sendToHost(pluginId: string, method: string, payload: unknown): Promise<unknown>
  hosts(): string[]
}

export function createVscodeExtensionsDependencies(input: {
  sendToHost: VscodeExtensionsDependencies["sendToHost"]
  hosts: VscodeExtensionsDependencies["hosts"]
}): VscodeExtensionsDependencies {
  return {
    ...input,
    extensions: () =>
      Object.values(usePluginStore.getState().plugins)
        .filter((plugin) => plugin.manifest.type === "vscode-extension")
        .map((plugin) => ({ id: plugin.manifest.id, path: plugin.path, status: plugin.status })),
    subscribe: (listener) =>
      usePluginStore.subscribe((state, previous) => {
        if (state.plugins !== previous.plugins) listener()
      }),
    // Imported when used: the manager imports the loader, which installs these handlers.
    resume: async (id) => {
      const { getPluginManager } = await import("@/lib/plugin/core/manager")
      await getPluginManager().resumePlugin(id, "activation")
    },
  }
}

let deps: VscodeExtensionsDependencies | null = null
let unsubscribe: (() => void) | null = null
/** Per host, the list it has (as JSON). */
const delivered = new Map<string, string>()

function requireDeps(): VscodeExtensionsDependencies {
  if (!deps) throw new Error("VS Code extensions are not available yet")
  return deps
}

function report(): { extensions: Array<{ id: string; extensionPath: string; isActive: boolean }> } {
  return {
    extensions: requireDeps()
      .extensions()
      .map((extension) => ({
        id: extension.id,
        extensionPath: extension.path,
        isActive: extension.status === "enabled",
      })),
  }
}

async function deliver(pluginId: string): Promise<void> {
  const payload = report()
  const json = JSON.stringify(payload)
  if (delivered.get(pluginId) === json) return
  delivered.set(pluginId, json)
  await requireDeps().sendToHost(pluginId, "extensions:changed", payload)
}

/** Give a host the installed extensions; the loader awaits this before activating. */
export function pushVscodeExtensions(pluginId: string): Promise<void> {
  delivered.delete(pluginId)
  return deliver(pluginId)
}

export function configureVscodeExtensions(next: VscodeExtensionsDependencies | null): void {
  unsubscribe?.()
  unsubscribe = null
  delivered.clear()
  deps = next
  if (!next) return
  unsubscribe = next.subscribe(() => {
    for (const pluginId of next.hosts()) {
      if (delivered.has(pluginId)) void deliver(pluginId).catch(() => undefined)
    }
  })
}

function find(id: string): InstalledVscodeExtension | undefined {
  const wanted = id.toLowerCase()
  return requireDeps()
    .extensions()
    .find((extension) => extension.id.toLowerCase() === wanted)
}

/** Resolve once `id` runs; reject when it stops trying or the wait runs out. */
function waitUntilRunning(id: string): Promise<void> {
  return new Promise((resolve, reject) => {
    let stop: () => void = () => {}
    const check = () => {
      const status = find(id)?.status
      if (status === "enabled") finish()
      else if (status !== "enabling" && status !== "loading") {
        finish(new Error(`${id} did not start (${status ?? "uninstalled"})`))
      }
    }
    const timer = setTimeout(
      () => finish(new Error(`${id} did not start within ${ACTIVATION_WAIT_MS / 1000}s`)),
      ACTIVATION_WAIT_MS
    )
    function finish(error?: Error) {
      clearTimeout(timer)
      stop()
      if (error) reject(error)
      else resolve()
    }
    stop = requireDeps().subscribe(check)
    check()
  })
}

async function activate(id: string): Promise<void> {
  const extension = find(id)
  if (!extension) throw new Error(`No VS Code extension ${id} is installed`)
  switch (extension.status) {
    case "enabled":
      return
    case "suspended":
      await requireDeps().resume(extension.id)
      return
    case "enabling":
    case "loading":
      await waitUntilRunning(extension.id)
      return
    default:
      throw new Error(`${extension.id} is not enabled; the user can enable it on the Plugins page`)
  }
}

function owned(payload: unknown, context: RpcContext): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("VS Code RPC payload must be an object")
  }
  const value = payload as Record<string, unknown>
  if (value.extensionId !== undefined && value.extensionId !== context.pluginId) {
    throw new Error(
      `VS Code RPC extension ownership mismatch: ${String(value.extensionId)} != ${context.pluginId}`
    )
  }
  return value
}

export function installVscodeExtensionsHandlers(): Array<() => void> {
  return [
    registerMethod("extensions:activate", async (payload, context) => {
      const value = owned(payload, context)
      if (typeof value.id !== "string" || !value.id)
        throw new Error("extensions:activate needs an id")
      await activate(value.id)
      return null
    }),
  ]
}

/** Forget what a stopped host had; a restarted one gets the list again. */
export function clearVscodeExtensionsForPlugin(pluginId: string): void {
  delivered.delete(pluginId)
}

export function __resetVscodeExtensionsForTesting(): void {
  configureVscodeExtensions(null)
}
