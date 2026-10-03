/**
 * Renderer side of `vscode.workspace.getConfiguration`.
 *
 * VS Code settings live in each VS Code plugin's own config (the store the
 * plugin settings form edits), under their VS Code keys. Every host gets
 * one snapshot of all of them (`workspace:configurationChanged`): the
 * defaults every installed extension contributes (its `configSchema`), plus
 * VS Code's defaults for core settings extensions commonly read, and the
 * values the user set. A host gets it before its extension activates, and
 * again with the keys that changed whenever any of it changes, which the
 * host turns into `onDidChangeConfiguration`.
 *
 * `workspace:configurationUpdate` writes through `applyPluginConfig`: a
 * setting an extension contributes is stored with that extension (and only
 * it may change it); a setting nobody contributes is stored with the
 * extension writing it. The caller's host has the new snapshot before the
 * update answers, so a read right after sees it, as in VS Code.
 */

import { subscribeAnyPluginConfigChange } from "@/lib/plugin/api/config-api"
import { applyPluginConfig } from "@/lib/plugin/core/apply-plugin-config"
import { validatePluginConfig } from "@/lib/plugin/core/validation"
import { usePluginStore } from "@/stores/plugin-runtime"
import type { PluginConfigSchema } from "@/types/plugin/plugin"

import { registerMethod, type RpcContext } from "./rpc-dispatcher"

/**
 * VS Code's own defaults for core settings extensions often read. There is
 * no VS Code workbench here to own them, so they are fixed values; telemetry
 * is off, which tells extensions not to send any.
 */
export const VSCODE_CORE_DEFAULTS: Readonly<Record<string, unknown>> = {
  "editor.tabSize": 4,
  "editor.insertSpaces": true,
  "editor.detectIndentation": true,
  "editor.fontSize": 14,
  "editor.wordWrap": "off",
  "editor.formatOnSave": false,
  "editor.formatOnType": false,
  "files.eol": "auto",
  "files.encoding": "utf8",
  "files.autoSave": "off",
  "files.exclude": {
    "**/.git": true,
    "**/.svn": true,
    "**/.hg": true,
    "**/CVS": true,
    "**/.DS_Store": true,
    "**/Thumbs.db": true,
  },
  "search.exclude": {
    "**/node_modules": true,
    "**/bower_components": true,
    "**/*.code-search": true,
  },
  "http.proxy": "",
  "http.proxyStrictSSL": true,
  "http.proxySupport": "override",
  "telemetry.telemetryLevel": "off",
}

export interface VscodeSettingsPlugin {
  id: string
  schema?: PluginConfigSchema
  config: Record<string, unknown>
}

export interface VscodeConfigurationDependencies {
  /** The installed VS Code extensions, with their settings schema and stored config. */
  plugins(): VscodeSettingsPlugin[]
  /** Something about the plugins or their config may have changed. */
  subscribe(listener: () => void): () => void
  apply(pluginId: string, config: Record<string, unknown>): Promise<void>
  sendToHost(pluginId: string, method: string, payload: unknown): Promise<unknown>
  hosts(): string[]
}

export function createVscodeConfigurationDependencies(input: {
  sendToHost: VscodeConfigurationDependencies["sendToHost"]
  hosts: VscodeConfigurationDependencies["hosts"]
}): VscodeConfigurationDependencies {
  return {
    ...input,
    plugins: () =>
      Object.values(usePluginStore.getState().plugins)
        .filter((plugin) => plugin.manifest.type === "vscode-extension")
        .map((plugin) => ({
          id: plugin.manifest.id,
          ...(plugin.manifest.configSchema ? { schema: plugin.manifest.configSchema } : {}),
          config: plugin.config ?? {},
        })),
    subscribe: (listener) => {
      const unsubscribeStore = usePluginStore.subscribe((state, previous) => {
        if (state.plugins !== previous.plugins) listener()
      })
      const unsubscribeConfig = subscribeAnyPluginConfigChange(() => listener())
      return () => {
        unsubscribeStore()
        unsubscribeConfig()
      }
    },
    apply: (pluginId, config) => applyPluginConfig(pluginId, config),
  }
}

interface Snapshot {
  defaults: Record<string, unknown>
  values: Record<string, unknown>
}

let deps: VscodeConfigurationDependencies | null = null
let unsubscribe: (() => void) | null = null
/** Per host, the snapshot it has. */
const delivered = new Map<string, Snapshot>()

function requireDeps(): VscodeConfigurationDependencies {
  if (!deps) throw new Error("VS Code settings are not available yet")
  return deps
}

function snapshot(): Snapshot {
  const defaults: Record<string, unknown> = { ...VSCODE_CORE_DEFAULTS }
  const values: Record<string, unknown> = {}
  for (const plugin of requireDeps().plugins()) {
    for (const [key, property] of Object.entries(plugin.schema?.properties ?? {})) {
      if (property.default !== undefined && !(key in defaults)) defaults[key] = property.default
    }
    for (const [key, value] of Object.entries(plugin.config)) {
      if (value !== undefined) values[key] = value
    }
  }
  return { defaults, values }
}

/** The settings whose effective value differs between two snapshots. */
function changedKeys(before: Snapshot, after: Snapshot): string[] {
  const effective = (snap: Snapshot) => ({ ...snap.defaults, ...snap.values })
  const a = effective(before)
  const b = effective(after)
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(
    (key) => JSON.stringify(a[key]) !== JSON.stringify(b[key])
  )
}

/**
 * Bring one host up to date. Its first snapshot carries no changed keys
 * (nothing has changed for an extension that has not seen any settings).
 */
async function deliver(pluginId: string): Promise<void> {
  const next = snapshot()
  const previous = delivered.get(pluginId)
  const changed = previous ? changedKeys(previous, next) : []
  if (previous && changed.length === 0) return
  delivered.set(pluginId, next)
  await requireDeps().sendToHost(pluginId, "workspace:configurationChanged", { ...next, changed })
}

/** Give a host its settings; the loader awaits this before activating. */
export function pushVscodeConfiguration(pluginId: string): Promise<void> {
  delivered.delete(pluginId)
  return deliver(pluginId)
}

export function configureVscodeConfiguration(next: VscodeConfigurationDependencies | null): void {
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

function object(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("VS Code RPC payload must be an object")
  }
  return payload as Record<string, unknown>
}

function owned(payload: unknown, context: RpcContext): Record<string, unknown> {
  const value = object(payload)
  if (value.extensionId !== undefined && value.extensionId !== context.pluginId) {
    throw new Error(
      `VS Code RPC extension ownership mismatch: ${String(value.extensionId)} != ${context.pluginId}`
    )
  }
  return value
}

async function update(
  pluginId: string,
  key: string,
  change: { remove: true } | { value: unknown }
): Promise<void> {
  const plugins = requireDeps().plugins()
  const owner = plugins.find((plugin) => plugin.schema?.properties[key] !== undefined)
  if (owner && owner.id !== pluginId) {
    throw new Error(
      `The setting ${key} belongs to ${owner.id}; an extension can only change its own`
    )
  }
  const target = owner ?? plugins.find((plugin) => plugin.id === pluginId)
  if (!target) throw new Error(`${pluginId} is not an installed VS Code extension`)
  const next = { ...target.config }
  if ("remove" in change) {
    delete next[key]
  } else {
    next[key] = change.value
    if (target.schema) {
      const errors = validatePluginConfig({ [key]: change.value }, target.schema).errors.filter(
        (error) => error.field === key || error.field.startsWith(`${key}.`)
      )
      if (errors.length > 0) {
        throw new Error(
          `Invalid value for ${key}: ${errors.map((error) => error.message).join("; ")}`
        )
      }
    }
  }
  await requireDeps().apply(target.id, next)
  await deliver(pluginId)
}

export function installVscodeConfigurationHandlers(): Array<() => void> {
  return [
    registerMethod("workspace:configurationUpdate", async (payload, context) => {
      const value = owned(payload, context)
      if (typeof value.key !== "string" || !value.key) {
        throw new Error("workspace:configurationUpdate needs a key")
      }
      await update(
        context.pluginId,
        value.key,
        value.remove === true ? { remove: true } : { value: value.value }
      )
      return null
    }),
  ]
}

/** Forget what a stopped host had; a restarted one gets a fresh snapshot. */
export function clearVscodeConfigurationForPlugin(pluginId: string): void {
  delivered.delete(pluginId)
}

export function __resetVscodeConfigurationForTesting(): void {
  configureVscodeConfiguration(null)
}
