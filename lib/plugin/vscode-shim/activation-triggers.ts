/**
 * What starts a VS Code extension that is enabled but not yet running, and
 * what it shows before it starts.
 *
 * An enabled extension starts at launch only when its activation events say
 * so (`*`, `onStartupFinished`, contributed views; see
 * `manifest-adapter.ts:planVscodeActivation`). Until then it is dormant, and
 * this module:
 *
 *   - lists its contributed commands in the command registry, with their
 *     titles, categories and `when` clauses; running one starts the extension
 *     (`onCommand:<id>`) and then runs the command it registered;
 *   - registers its contributed languages, so a file of one opens as that
 *     language;
 *   - starts it when an editor opens a document of a language it declared
 *     (`onLanguage:<id>`, fired for every plugin);
 *   - starts it when an open project folder holds a file matching one of its
 *     `workspaceContains:` globs, checked when it becomes dormant and when the
 *     folders change.
 *
 * Starting goes through the plugin manager's activation events, so a
 * disabled extension stays off and a failing one trips the manager's breaker.
 * Once the extension is starting, its placeholders and languages give way to
 * the ones it registers itself. `onUri` and `onAuthenticationRequest` are
 * fired where those happen (`route-deep-link.ts`, `runtime-handlers.ts`).
 */

import { statWorkspaceFile, walkWorkspace } from "@/lib/files/workspace-fs"
import {
  registerLanguagesForPlugin,
  unregisterLanguagesByPlugin,
} from "@/lib/plugin/bridge/languages-bridge"
import {
  getCommand,
  registerCommand,
  subscribeCommandRegistry,
  type CommandHandler,
  type CommandRegistration,
} from "@/lib/plugin/commands/registry"
import { usePluginStore } from "@/stores/plugin-runtime"
import type { PluginManifest, PluginStatus } from "@/types/plugin/plugin"
import type { VsCodeContributedCommand, VsCodeLanguage } from "@/types/plugin/plugin-vscode"

import { listProjectWorkspaceFolders, onWorkspaceFoldersChanged } from "./lsp-workspace-manager"
import { getEditorById, onEditorChange } from "./monaco-bridge"
import { appendVscodeLog } from "./vscode-log-buffer"
import { matchesGlob, matchesGlobOrParent } from "./vscode-glob"

/** Statuses of an extension that is installed but not running. */
const DORMANT_STATUSES: ReadonlySet<PluginStatus> = new Set([
  "discovered",
  "installed",
  "disabled",
  "suspended",
])

/** How long a started extension has to register the command that started it. */
export const COMMAND_REGISTRATION_WAIT_MS = 5_000
/** Files looked at per folder for one extension's `workspaceContains:` globs. */
export const WORKSPACE_CONTAINS_WALK_LIMIT = 50_000
/** Folders never searched, as VS Code's default `files.exclude`. */
const WORKSPACE_CONTAINS_EXCLUDES = ["**/.git", "**/.svn", "**/.hg", "**/CVS", "**/node_modules"]

export interface ActivationTriggerPlugin {
  status: PluginStatus
  manifest: PluginManifest
}

export interface VscodeActivationTriggerDependencies {
  /** Every installed plugin. */
  plugins(): ActivationTriggerPlugin[]
  subscribePlugins(listener: () => void): () => void
  /** Whether the user has not disabled the plugin (its lifecycle intent). */
  wantsEnabled(pluginId: string): Promise<boolean>
  /** Fire a runtime activation event through the plugin manager. */
  activate(event: string): Promise<void>
  commands: {
    register(registration: CommandRegistration): () => void
    get(id: string): CommandRegistration | undefined
    /** Resolves once something other than `placeholder` is registered as `id`, or after `timeoutMs`. */
    waitFor(id: string, placeholder: CommandHandler, timeoutMs: number): Promise<void>
  }
  languages: {
    register(pluginId: string, languages: VsCodeLanguage[]): void
    unregister(pluginId: string): void
  }
  /** Each document an editor opens, by language id. */
  onEditorLanguage(listener: (languageId: string) => void): () => void
  /** Absolute paths of the open project folders. */
  folders(): string[]
  onFoldersChanged(listener: () => void): () => void
  /** Whether `relPath` exists under `root`. */
  exists(root: string, relPath: string): Promise<boolean>
  /** Paths (relative to `root`, `/`-separated) of the files under it, up to `maxEntries`. */
  walk(root: string, maxEntries: number): Promise<{ files: string[]; truncated: boolean }>
  log(pluginId: string, level: "info" | "warn", message: string): void
}

export function createVscodeActivationTriggerDependencies(): VscodeActivationTriggerDependencies {
  return {
    plugins: () => Object.values(usePluginStore.getState().plugins),
    subscribePlugins: (listener) =>
      usePluginStore.subscribe((state, previous) => {
        if (state.plugins !== previous.plugins) listener()
      }),
    wantsEnabled: async (pluginId) => {
      const { getPluginManager } = await import("@/lib/plugin/core/manager")
      return (await getPluginManager().getPluginLifecycleState(pluginId)).intent !== "disabled"
    },
    activate: async (event) => {
      const { ensureBootCapability, getBootProfile } = await import("@/lib/boot/capabilities")
      if (getBootProfile() === "main") await ensureBootCapability("plugin-runtime")
      const { getPluginManager } = await import("@/lib/plugin/core/manager")
      await getPluginManager().handleActivationEvent(
        event as Parameters<ReturnType<typeof getPluginManager>["handleActivationEvent"]>[0]
      )
    },
    commands: {
      register: registerCommand,
      get: getCommand,
      waitFor: (id, placeholder, timeoutMs) =>
        new Promise<void>((resolve) => {
          const replaced = () => {
            const current = getCommand(id)
            return Boolean(current && current.handler !== placeholder)
          }
          if (replaced()) return resolve()
          const timer = setTimeout(done, timeoutMs)
          const unsubscribe = subscribeCommandRegistry((event) => {
            if (event.id === id && event.type === "register" && replaced()) done()
          })
          function done() {
            clearTimeout(timer)
            unsubscribe()
            resolve()
          }
        }),
    },
    languages: {
      register: (pluginId, languages) => {
        registerLanguagesForPlugin(pluginId, languages)
      },
      unregister: (pluginId) => {
        unregisterLanguagesByPlugin(pluginId)
      },
    },
    onEditorLanguage: (listener) =>
      onEditorChange((event) => {
        if (event.kind !== "open" && event.kind !== "change-language") return
        const language = getEditorById(event.editorId)?.getModel()?.language
        if (language) listener(language)
      }),
    folders: () => listProjectWorkspaceFolders().map((folder) => folder.path),
    onFoldersChanged: onWorkspaceFoldersChanged,
    exists: async (root, relPath) => (await statWorkspaceFile(root, relPath)).exists,
    walk: async (root, maxEntries) => {
      const result = await walkWorkspace(root, { maxEntries })
      return {
        files: result.entries.filter((entry) => !entry.isDir).map((entry) => entry.relPath),
        truncated: result.truncated,
      }
    },
    log: (pluginId, level, message) =>
      appendVscodeLog(pluginId, { level, kind: "activation", message }),
  }
}

interface DormantState {
  /** Command id → the placeholder handler registered for it. */
  commands: Map<string, CommandHandler>
  languages: boolean
  /** The folders its `workspaceContains:` globs were checked against. */
  checkedFolders: string
}

let deps: VscodeActivationTriggerDependencies | null = null
let teardown: Array<() => void> = []
const dormant = new Map<string, DormantState>()
/** Placeholder handler → what takes it out of the command registry. */
const registeredDisposers = new Map<CommandHandler, () => void>()
let reconciling: Promise<void> = Promise.resolve()

/** An extension that waits for its activation events (see `activationPlanned`). */
function isVscode(plugin: ActivationTriggerPlugin): boolean {
  return (
    plugin.manifest.type === "vscode-extension" &&
    plugin.manifest.vscodeExtension?.activationPlanned === true
  )
}

function workspaceGlobs(manifest: PluginManifest): string[] {
  return (manifest.activationEvents ?? [])
    .filter((event) => event.startsWith("workspaceContains:"))
    .map((event) => event.slice("workspaceContains:".length))
    .filter(Boolean)
}

function languageEvents(manifest: PluginManifest): string[] {
  return (manifest.activationEvents ?? [])
    .filter((event) => event.startsWith("onLanguage:"))
    .map((event) => event.slice("onLanguage:".length))
}

/** Take down what was shown for a plugin, leaving anything it registered itself. */
function release(pluginId: string): void {
  const state = dormant.get(pluginId)
  if (!state || !deps) return
  dormant.delete(pluginId)
  for (const [id, handler] of state.commands) {
    const current = deps.commands.get(id)
    if (current?.handler === handler && current.pluginId === pluginId) {
      // `register` returned an unregister; the registry's own is equivalent.
      registeredDisposers.get(handler)?.()
    }
    registeredDisposers.delete(handler)
  }
  if (state.languages) deps.languages.unregister(pluginId)
}

function placeholderFor(pluginId: string, entry: VsCodeContributedCommand): CommandHandler {
  const handler: CommandHandler = async (...args) => {
    const { activate, commands } = requireDeps()
    await activate(`onCommand:${entry.command}`)
    await commands.waitFor(entry.command, handler, COMMAND_REGISTRATION_WAIT_MS)
    const registered = commands.get(entry.command)
    if (!registered || registered.handler === handler) {
      throw new Error(
        `VS Code extension ${pluginId} did not register the command ${entry.command} when it started`
      )
    }
    return registered.handler(...args)
  }
  return handler
}

function showCommands(plugin: ActivationTriggerPlugin, state: DormantState): void {
  const { commands } = requireDeps()
  const pluginId = plugin.manifest.id
  for (const entry of plugin.manifest.vscodeExtension?.commands ?? []) {
    const existing = state.commands.get(entry.command)
    const current = commands.get(entry.command)
    if (existing && current?.handler === existing) continue
    // Someone else owns the id; theirs stays.
    if (current && current.handler !== existing) continue
    const handler = placeholderFor(pluginId, entry)
    const dispose = commands.register({
      id: entry.command,
      pluginId,
      title: entry.title,
      ...(entry.category ? { category: entry.category } : {}),
      ...(entry.when ? { when: entry.when } : {}),
      handler,
    })
    if (existing) registeredDisposers.delete(existing)
    state.commands.set(entry.command, handler)
    registeredDisposers.set(handler, dispose)
  }
}

async function evaluateWorkspaceContains(plugin: ActivationTriggerPlugin, state: DormantState) {
  const { folders, exists, walk, activate, log } = requireDeps()
  const globs = workspaceGlobs(plugin.manifest)
  const roots = folders()
  const key = roots.join("\n")
  if (globs.length === 0 || roots.length === 0 || state.checkedFolders === key) return
  state.checkedFolders = key
  const pluginId = plugin.manifest.id
  const literal = globs.filter((glob) => !/[*?[{]/.test(glob))
  const patterns = globs.filter((glob) => /[*?[{]/.test(glob))
  for (const root of roots) {
    for (const path of literal) {
      if (await exists(root, path.replace(/^\.?\//, ""))) {
        await activate(`workspaceContains:${pluginId}`)
        return
      }
    }
    if (patterns.length === 0) continue
    const { files, truncated } = await walk(root, WORKSPACE_CONTAINS_WALK_LIMIT)
    const match = files.some(
      (file) =>
        !WORKSPACE_CONTAINS_EXCLUDES.some((exclude) => matchesGlobOrParent(exclude, file)) &&
        patterns.some((glob) => matchesGlob(glob, file))
    )
    if (match) {
      await activate(`workspaceContains:${pluginId}`)
      return
    }
    if (truncated) {
      log(
        pluginId,
        "warn",
        `workspaceContains: searched only the first ${WORKSPACE_CONTAINS_WALK_LIMIT} files of ${root}`
      )
    }
  }
}

/** Bring what is shown in line with which extensions are dormant. */
async function reconcile(): Promise<void> {
  const current = requireDeps()
  const plugins = current.plugins().filter(isVscode)
  const byId = new Map(plugins.map((plugin) => [plugin.manifest.id, plugin]))
  for (const pluginId of [...dormant.keys()]) {
    const plugin = byId.get(pluginId)
    if (!plugin || !DORMANT_STATUSES.has(plugin.status)) release(pluginId)
  }
  for (const plugin of plugins) {
    if (!DORMANT_STATUSES.has(plugin.status)) continue
    const pluginId = plugin.manifest.id
    if (!(await current.wantsEnabled(pluginId))) {
      release(pluginId)
      continue
    }
    // The status may have moved on while the intent was read.
    const latest = current.plugins().find((entry) => entry.manifest.id === pluginId)
    if (!latest || !DORMANT_STATUSES.has(latest.status) || deps !== current) continue
    let state = dormant.get(pluginId)
    if (!state) {
      state = { commands: new Map(), languages: false, checkedFolders: "" }
      dormant.set(pluginId, state)
    }
    showCommands(latest, state)
    const languages = latest.manifest.vscodeLanguages ?? []
    if (!state.languages && languages.length > 0) {
      current.languages.register(pluginId, languages)
      state.languages = true
    }
    await evaluateWorkspaceContains(latest, state).catch((error: unknown) =>
      current.log(
        pluginId,
        "warn",
        `workspaceContains: could not search the open folders: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    )
  }
}

function schedule(): void {
  const current = deps
  if (!current) return
  // An extension that has started gives way at once, before it registers its
  // own commands and languages; the rest waits for the intents.
  for (const plugin of current.plugins()) {
    if (isVscode(plugin) && !DORMANT_STATUSES.has(plugin.status)) release(plugin.manifest.id)
  }
  reconciling = reconciling
    .then(() => (deps === current ? reconcile() : undefined))
    .catch(() => {
      // A failed pass leaves the previous state; the next change retries.
    })
}

function requireDeps(): VscodeActivationTriggerDependencies {
  if (!deps) throw new Error("VS Code activation triggers are not installed")
  return deps
}

/** Fire `onLanguage:<id>` for a document an editor opened, once per language. */
const firedLanguages = new Set<string>()

function onEditorLanguage(languageId: string): void {
  if (!languageId || firedLanguages.has(languageId)) return
  const current = deps
  if (!current) return
  const interested = current
    .plugins()
    .some(
      (plugin) =>
        DORMANT_STATUSES.has(plugin.status) &&
        languageEvents(plugin.manifest).some((id) => id === languageId || id === "*")
    )
  if (!interested) return
  firedLanguages.add(languageId)
  void current.activate(`onLanguage:${languageId}`).finally(() => {
    // A later document of the language may find another plugin dormant.
    firedLanguages.delete(languageId)
  })
}

/** Start watching. Replaces an earlier installation. */
export function installVscodeActivationTriggers(next: VscodeActivationTriggerDependencies): void {
  uninstallVscodeActivationTriggers()
  deps = next
  teardown = [
    next.subscribePlugins(schedule),
    next.onFoldersChanged(schedule),
    next.onEditorLanguage(onEditorLanguage),
  ]
  schedule()
}

/** Stop watching and take down everything shown for dormant extensions. */
export function uninstallVscodeActivationTriggers(): void {
  for (const dispose of teardown) dispose()
  teardown = []
  for (const pluginId of [...dormant.keys()]) release(pluginId)
  deps = null
  firedLanguages.clear()
}

/** Resolves when the work already scheduled is done (tests). */
export function __settleVscodeActivationTriggers(): Promise<void> {
  return reconciling
}
