import type {
  ExtensionCompatibilityDiagnostic,
  PluginDefinition,
  PluginManifest,
} from "@/types/plugin"
import type { PluginSharedModule } from "./shared-modules"
import browserBuiltinAssets from "./browser-builtin-assets.generated.json"

export interface BrowserBuiltinAsset {
  url: string
  sha256: string
  sharedModules: PluginSharedModule[]
  stylesUrl?: string
  /** Package-owned files published beside the compiled entry. */
  resourcesUrl?: string
  /** Integrity pins for separately compiled contribution entrypoints. */
  entryHashes?: Record<string, string>
}

export interface BrowserBuiltinRegistryEntry {
  manifest: PluginManifest
  path: `builtin://${string}`
  compatibilityDiagnostics: ExtensionCompatibilityDiagnostic[]
  asset?: BrowserBuiltinAsset
  load?: () => Promise<PluginDefinition>
  /**
   * Full module export namespace, cached by the loader as the plugin's
   * `moduleExports`. Set this only for built-ins whose manifest declares
   * `connectors[]` (or any other bridge that resolves a factory by name from
   * exports) — otherwise the loader falls back to `{ default: definition }`,
   * which drops the named factory functions and the bridge skips them.
   */
  moduleExports?: Record<string, unknown>
  /** Bundled source for a built-in manifest.styles entry. */
  bundledStyles?: string
}

/**
 * One entry from the generated asset catalog, copied out of it.
 *
 * The catalog is an imported JSON module object, so `entries[pluginId]` is a
 * live reference into it and `browserBuiltins` below is long-lived. Copying
 * here — rather than at each of the five call sites — keeps the registry from
 * aliasing module state, and keeps `compatibilityDiagnostics` an array this
 * registry owns, like every hand-written entry's.
 */
function generatedBuiltin(pluginId: string): BrowserBuiltinRegistryEntry {
  const entries = browserBuiltinAssets.entries as unknown as Record<
    string,
    BrowserBuiltinRegistryEntry
  >
  const entry = entries[pluginId]
  if (!entry) throw new Error(`Missing generated browser builtin asset for ${pluginId}`)
  return { ...entry, compatibilityDiagnostics: [...(entry.compatibilityDiagnostics ?? [])] }
}

function resolvePluginModule(mod: unknown): PluginDefinition {
  return (mod as { default?: PluginDefinition }).default || (mod as PluginDefinition)
}

/**
 * Build a builtin entry's discovery manifest by overlaying the module
 * definition's manifest on top of the plugin.json base.
 *
 * The declarative contribution arrays (workflowTemplates / skills /
 * mcpServerPresets / characterPacks / agentTeamTemplates / subagents /
 * dexie / i18n) are authored in TypeScript on the module manifest, next to
 * the runtime values they reference (custom node kinds, prompt constants) —
 * plugin.json cannot hold them. Discovery (`scanBrowserBuiltins`) persists
 * the manifest it gets here into the plugin store, and the manager's
 * `OVERLAY_REGISTRY_CAPABILITIES` dispatch loop plus the dexie/i18n enable
 * steps read those fields from the store record. Without this merge they
 * read fields that don't exist and silently skip every declarative
 * contribution (the bug that left e.g. the zhihu-content-pipeline workflow
 * template unregistered).
 *
 * plugin.json stays the base so identity/compat fields the module manifest
 * omits (description, author, license, engines, activationEvents,
 * runtimeCompatibility) survive; `id` stays authoritative from the JSON.
 */
export function builtinManifest(jsonManifest: unknown, mod: unknown): PluginManifest {
  const base = jsonManifest as PluginManifest
  const rich = resolvePluginModule(mod)?.manifest as PluginManifest | undefined
  if (!rich) return base
  return { ...base, ...rich, id: base.id }
}

const browserBuiltins: BrowserBuiltinRegistryEntry[] = Object.keys(
  browserBuiltinAssets.entries
).map(generatedBuiltin)

function isBrowserBuiltinAvailable(entry: BrowserBuiltinRegistryEntry): boolean {
  if (
    process.env.NEXT_PUBLIC_E2E === "1" &&
    typeof window !== "undefined" &&
    window.location.pathname === "/e2e/plugin-ui-surfaces"
  ) {
    return entry.manifest.id === "ui-surface-reference"
  }
  return entry.manifest.id !== "ui-surface-reference" || process.env.NEXT_PUBLIC_E2E === "1"
}

export function getBrowserBuiltinRegistry(): BrowserBuiltinRegistryEntry[] {
  return browserBuiltins.filter(isBrowserBuiltinAvailable).map((entry) => ({
    ...entry,
    compatibilityDiagnostics: [...entry.compatibilityDiagnostics],
  }))
}

export function getBrowserBuiltinRegistryEntry(
  pluginId: string
): BrowserBuiltinRegistryEntry | undefined {
  return browserBuiltins.find(
    (entry) => entry.manifest.id === pluginId && isBrowserBuiltinAvailable(entry)
  )
}
