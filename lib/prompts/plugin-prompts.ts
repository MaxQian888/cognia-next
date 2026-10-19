/**
 * Plugin-contributed prompt slots (ADR-0236 §3.2, §5.1).
 *
 * A plugin's prompt has no editable source of its own: it is bundled in the
 * plugin, and a copy into a user-owned record would lose what that record
 * cannot carry (a subagent's effort or disallowed tools). Such a prompt is a
 * slot in the generic override store, exactly like a code-owned one, under a
 * namespaced id `plugin:<pluginId>/<localId>` that can never collide with a
 * shipped id or another plugin's.
 *
 * The registry is runtime state: entries exist while their plugin is enabled.
 * Everything a plugin may declare is wording (title, default body, variables,
 * fragments it parses against, a budget); the authority fields are assigned
 * here, never taken from the plugin: an ordinary replace-template entry,
 * overridable for the account or a workspace, used from the next call, on the
 * app host. An override outlives its plugin; while the plugin is gone the
 * Prompt Center lists it as unavailable rather than dropping the user's text.
 *
 * This module stays a leaf (the definition helpers only), so the catalog can
 * merge it without loading the plugin runtime.
 */

import { validatePromptBody } from "./template"
import {
  definePrompt,
  type PromptDefinitionV1,
  type PromptGroup,
  type PromptVariableSpec,
} from "./types"

export const PLUGIN_PROMPT_ID_PREFIX = "plugin:"

/** A plugin id or local id: what plugin manifests already allow, no separators. */
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

/** Ceiling a plugin may ask for; the shipped default must fit too. */
export const PLUGIN_PROMPT_MAX_CHARS = 32_000

export function pluginPromptId(pluginId: string, localId: string): string {
  return `${PLUGIN_PROMPT_ID_PREFIX}${pluginId}/${localId}`
}

export function isPluginPromptId(id: string): boolean {
  return id.startsWith(PLUGIN_PROMPT_ID_PREFIX)
}

/** `plugin:<pluginId>/<localId>` → its parts, or `undefined` for other ids. */
export function parsePluginPromptId(id: string): { pluginId: string; localId: string } | undefined {
  if (!isPluginPromptId(id)) return undefined
  const rest = id.slice(PLUGIN_PROMPT_ID_PREFIX.length)
  const slash = rest.indexOf("/")
  if (slash <= 0) return undefined
  const pluginId = rest.slice(0, slash)
  const localId = rest.slice(slash + 1)
  return SEGMENT.test(pluginId) && SEGMENT.test(localId) ? { pluginId, localId } : undefined
}

/** What a plugin declares for one prompt. */
export interface PluginPromptDeclaration {
  /** Unique within the plugin. */
  id: string
  /** Shown in the Prompt Center; plugins localize it themselves. */
  title: string
  description?: string
  /** The plugin's own default, exactly as it sends it with no override. */
  defaultBody: string
  /** Bump when the variables, fragments or output contract change. Defaults to 1. */
  contractVersion?: number
  variables?: readonly PromptVariableSpec[]
  requiredFragments?: readonly string[]
  outputContract?: string
  maxChars?: number
  /** Where the entry is grouped; `agents` when omitted. */
  group?: PromptGroup
}

/** Host-assigned settings for a contribution kind. */
export interface PluginPromptOptions {
  /** Defaults to the account and the workspace the consumer resolves in. */
  scopes?: readonly ("account" | "workspace")[]
}

export interface PluginPromptEntry {
  pluginId: string
  localId: string
  title: string
  description?: string
  def: PromptDefinitionV1
}

const entries = new Map<string, PluginPromptEntry>()
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

/** Build the host-owned definition for one declaration. Throws on an invalid one. */
export function pluginPromptDefinition(
  pluginId: string,
  declaration: PluginPromptDeclaration,
  consumer: string,
  options: PluginPromptOptions = {}
): PromptDefinitionV1 {
  if (!SEGMENT.test(pluginId)) throw new Error(`invalid plugin id for a prompt: ${pluginId}`)
  if (!SEGMENT.test(declaration.id)) {
    throw new Error(`plugin ${pluginId}: invalid prompt id "${declaration.id}"`)
  }
  if (!declaration.title.trim()) {
    throw new Error(`plugin ${pluginId}: prompt ${declaration.id} needs a title`)
  }
  const maxChars = Math.min(
    declaration.maxChars ?? PLUGIN_PROMPT_MAX_CHARS,
    PLUGIN_PROMPT_MAX_CHARS
  )
  const def = definePrompt({
    id: pluginPromptId(pluginId, declaration.id),
    contractVersion: declaration.contractVersion ?? 1,
    kind: "feature-template",
    group: declaration.group ?? "agents",
    operation: "replace-template",
    scopes: options.scopes ?? ["account", "workspace"],
    activation: "next-operation",
    risk: "ordinary",
    hosts: ["app"],
    defaultBody: declaration.defaultBody,
    variables: declaration.variables ?? [],
    requiredFragments: declaration.requiredFragments ?? [],
    maxChars,
    ...(declaration.outputContract ? { outputContract: declaration.outputContract } : {}),
    consumers: [consumer],
  })
  // The default must meet its own contract, as every shipped default does;
  // otherwise no override could ever be checked against it.
  const issues = validatePromptBody(def, def.defaultBody)
  if (issues.length > 0) {
    throw new Error(
      `plugin ${pluginId}: prompt ${declaration.id} default is invalid (${issues
        .map((issue) => issue.code)
        .join(", ")})`
    )
  }
  return def
}

/**
 * Register prompts of a plugin, replacing any registered under the same ids.
 * Returns a disposer that removes exactly these entries. All declarations are
 * checked first, so an invalid one registers none. `scopes` is the host's
 * choice for the contribution kind (a consumer that resolves without a
 * workspace offers only the account scope); a plugin never picks it.
 */
export function registerPluginPrompts(
  pluginId: string,
  declarations: readonly PluginPromptDeclaration[],
  consumer: string,
  options: PluginPromptOptions = {}
): () => void {
  const seen = new Set<string>()
  const built = declarations.map((declaration) => {
    if (seen.has(declaration.id)) {
      throw new Error(`plugin ${pluginId}: duplicate prompt id "${declaration.id}"`)
    }
    seen.add(declaration.id)
    const def = pluginPromptDefinition(pluginId, declaration, consumer, options)
    return {
      pluginId,
      localId: declaration.id,
      title: declaration.title.trim(),
      ...(declaration.description?.trim() ? { description: declaration.description.trim() } : {}),
      def,
    } satisfies PluginPromptEntry
  })
  for (const entry of built) entries.set(entry.def.id, entry)
  emit()
  return () => {
    let changed = false
    for (const entry of built) {
      if (entries.get(entry.def.id) === entry) {
        entries.delete(entry.def.id)
        changed = true
      }
    }
    if (changed) emit()
  }
}

/** Drop a plugin's prompts (disable / uninstall), or only those whose local id starts with `localIdPrefix`. */
export function unregisterPluginPrompts(pluginId: string, localIdPrefix = ""): void {
  let changed = false
  for (const [id, entry] of entries) {
    if (entry.pluginId === pluginId && entry.localId.startsWith(localIdPrefix)) {
      entries.delete(id)
      changed = true
    }
  }
  if (changed) emit()
}

export function getPluginPromptEntry(id: string): PluginPromptEntry | undefined {
  return entries.get(id)
}

export function listPluginPromptEntries(): PluginPromptEntry[] {
  return [...entries.values()].sort((a, b) => a.def.id.localeCompare(b.def.id))
}

export function onPluginPromptsChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function __resetPluginPromptsForTesting(): void {
  entries.clear()
  listeners.clear()
}
