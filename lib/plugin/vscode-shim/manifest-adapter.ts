/**
 * VS Code → cognia manifest adapter.
 *
 * Translates a parsed `.vsix` (output of `vsix-installer.ts:installVsix`)
 * plus the inferred permission set (output of
 * `permission-inference.ts:inferPermissions`, Phase M0) into the cognia
 * `PluginManifest` the existing `PluginManager` consumes.
 *
 * Design contract:
 *   • The adapter is a pure function — no I/O, no Tauri calls.
 *   • It is loss-aware: cognia-side fields that have no VS Code analogue
 *     stay empty; VS Code-side fields that have no cognia analogue land in
 *     `manifest.vscodeExtension` so the sidecar can re-consult them.
 *   • Activation events flow through `planVscodeActivation`: the events
 *     Cognia fires pass through (some become `startup`), VS Code's implicit
 *     events for contributed commands, languages and authentication providers
 *     are added, and the rest are recorded as unsupported. The originals stay
 *     in `vscodeExtension.activationEvents`.
 *   • Synthetic id is always `publisher.name`. The sidecar uses this same id
 *     to namespace storage, secrets, and Dexie tables.
 */

import type { PluginManifest, PluginCapability, PluginPermission } from "@/types/plugin/plugin"
import type {
  VsCodeManifest,
  VsCodeActivationEvent,
  VsCodeContributedCommand,
  VsCodeExtensionAdapterResult,
  VsCodeExtensionBlock,
  VsCodePermissionInference,
  VsCodeUnsupportedContribution,
} from "@/types/plugin/plugin-vscode"
import type { ActivationEventDeclaration } from "@/lib/plugin/contracts/plugin-points"
import type { VsixInstallResult } from "./vsix-installer"
import { canonicalExtensionId } from "./extension-id"
import { evaluateEngineCompat } from "./engine-compat"
import {
  nlsKeyOf,
  readNlsBundles,
  resolveNls,
  vscodeConfigurationToSchema,
} from "./vscode-configuration-schema"

export interface AdaptVscodeManifestInput {
  /** Output of `installVsix`. */
  vsix: VsixInstallResult
  /** Output of `inferPermissions` (Phase M0 / Task #13). */
  inference: VsCodePermissionInference
  /** Install source. Use `"vsix-upload"` for drag-drop, `"openvsx"` for registry. */
  source: VsCodeExtensionBlock["source"]
  /**
   * The Open VSX `targetPlatform` this build was resolved for. Supplied by the
   * marketplace path (which is the only caller that knows it — the platform is
   * a registry fact, absent from the archive's own `package.json`); omitted for
   * `.vsix` uploads. Recorded so the update check re-queries the platform that
   * was actually installed.
   */
  targetPlatform?: string
}

/**
 * Translate a parsed VS Code extension into a cognia `PluginManifest`.
 *
 * Returns the synthesised manifest, the original VS Code manifest verbatim,
 * the inference result, the LSP binary candidates, and any non-fatal
 * warnings the adapter emitted during translation.
 */
export function adaptVscodeManifest(input: AdaptVscodeManifestInput): VsCodeExtensionAdapterResult {
  const { vsix, inference, source, targetPlatform } = input
  const { pkgJson } = vsix
  const warnings: string[] = []

  const id = canonicalId(pkgJson)
  // `%key%` strings come from `package.nls*.json`: the default bundle gives
  // the literal, and the per-locale bundles let the app show the user's
  // language through `nameKey` / `descriptionKey`.
  const nls = readNlsBundles(vsix.files, warnings)
  const rawDisplayName =
    typeof pkgJson.displayName === "string" && pkgJson.displayName.length > 0
      ? pkgJson.displayName
      : pkgJson.name
  const displayName = resolveNls(rawDisplayName, nls)
  const nameKey = nlsKeyOf(rawDisplayName)
  const rawDescription = typeof pkgJson.description === "string" ? pkgJson.description : undefined
  const description = rawDescription !== undefined ? resolveNls(rawDescription, nls) : displayName
  const descriptionKey = nlsKeyOf(rawDescription)
  const hasNlsLocales = Object.keys(nls.locales).length > 0
  const license = typeof pkgJson.license === "string" ? pkgJson.license : undefined
  const homepage = typeof pkgJson.homepage === "string" ? pkgJson.homepage : undefined
  const repository = resolveRepositoryUrl(pkgJson.repository)
  const keywords = Array.isArray(pkgJson.keywords)
    ? pkgJson.keywords.filter((k): k is string => typeof k === "string")
    : undefined
  const author = {
    name: pkgJson.publisher,
    ...(typeof pkgJson.homepage === "string" ? { url: pkgJson.homepage } : {}),
  }

  // ── Activation events ──────────────────────────────────────────────────
  const rawActivation = Array.isArray(pkgJson.activationEvents) ? pkgJson.activationEvents : []
  const activation = planVscodeActivation(pkgJson, warnings)
  const cogniaActivation = activation.events

  // ── Contributed commands ──────────────────────────────────────────────
  const contributedCommands = vscodeContributedCommands(pkgJson, nls)

  // ── What Cognia does not provide ─────────────────────────────────────
  const unsupportedContributions = vscodeUnsupportedContributions(pkgJson, vsix.bundleFormat)

  // ── Capabilities ──────────────────────────────────────────────────────
  const capabilities = inferCapabilities(pkgJson)

  // ── Permissions ───────────────────────────────────────────────────────
  // Static-analysis permissions become the manifest's required set.
  // Optional permissions stay empty — the sidecar's runtime gate handles
  // permission upgrades on first sensitive `require()` call.
  const permissions: PluginPermission[] = [...new Set(inference.permissions)]

  // ── Engine / API compatibility (advisory) ─────────────────────────────
  // Evaluated here so the outcome rides the manifest all the way to the
  // extension card — a warning that only lived in the install dialog would
  // disappear at the moment it becomes most relevant (the extension is now
  // installed and misbehaving). Reported, never enforced: `blocked` is
  // typed `false`, and nothing below reads it.
  const engineCompat = evaluateEngineCompat({
    engineVscode: pkgJson.engines?.vscode,
    inference,
  })
  for (const warning of engineCompat.warnings) {
    if (warning.kind === "unsupported-api") {
      warnings.push(
        `This extension uses APIs cognia doesn't implement (${warning.namespaces.join(", ")}) — it may not work.`
      )
    } else if (warning.kind === "engine-mismatch") {
      warnings.push(
        `Extension requires VS Code ${warning.required}; cognia's shim reports ${warning.shimVersion}. ` +
          `Not a blocker — the range says nothing about which APIs are used.`
      )
    }
  }

  // ── vscodeExtension block ─────────────────────────────────────────────
  const vscodeExtensionBlock: VsCodeExtensionBlock = {
    identifier: id,
    version: pkgJson.version,
    engineVscode: pkgJson.engines?.vscode ?? "*",
    vsixSha256: vsix.sha256,
    source,
    bundleFormat: vsix.bundleFormat ?? "cjs",
    activationEvents: rawActivation as VsCodeActivationEvent[],
    ...(activation.unsupported.length > 0
      ? { unsupportedActivationEvents: activation.unsupported }
      : {}),
    ...(contributedCommands.length > 0 ? { commands: contributedCommands } : {}),
    ...(unsupportedContributions.length > 0 ? { unsupportedContributions } : {}),
    activationPlanned: true,
    // Both spread-conditionally: an absent key is "not applicable" (a `.vsix`
    // upload has no registry platform), whereas `[]` would assert "we looked
    // and found none" — a claim the minified path cannot support.
    ...(targetPlatform !== undefined ? { targetPlatform } : {}),
    ...(engineCompat.unsupportedApis.length > 0
      ? { unsupportedApis: engineCompat.unsupportedApis }
      : {}),
  }

  // ── Themes contributed via VS Code ────────────────────────────────────
  const themes = vsix.themes.map((t, index) => ({
    id: t.label.toLowerCase().replace(/[^a-z0-9]+/g, "-") || `theme-${index}`,
    name: t.label,
    vscodeJsonPath: t.path,
  }))

  // ── Languages contributed via VS Code ─────────────────────────────────
  // Projected onto the manifest so the plugin manager can register them with
  // Monaco + cognia's language detection on enable. Only entries with a
  // string `id` survive; everything else is preserved verbatim.
  const rawLanguages = Array.isArray(pkgJson.contributes?.languages)
    ? pkgJson.contributes.languages
    : []
  const vscodeLanguages = rawLanguages.filter(
    (lang): lang is (typeof rawLanguages)[number] =>
      Boolean(lang) && typeof (lang as { id?: unknown }).id === "string"
  )

  // ── Grammars / icon themes / snippets contributed via VS Code (W5.1) ──
  // Projected onto the manifest so the plugin manager can feed the
  // grammars/icons/snippets bridges on enable. Only structurally valid
  // entries survive; paths stay relative (the bridges enforce traversal
  // safety again at read time).
  const rawGrammars = Array.isArray(pkgJson.contributes?.grammars)
    ? (pkgJson.contributes.grammars as unknown as Array<Record<string, unknown>>)
    : []
  const vscodeGrammars = rawGrammars
    .filter((g) => g && typeof g.scopeName === "string" && typeof g.path === "string")
    .map((g) => ({
      scopeName: g.scopeName as string,
      ...(typeof g.language === "string" ? { language: g.language } : {}),
      path: g.path as string,
    }))

  const rawIconThemes = Array.isArray(pkgJson.contributes?.iconThemes)
    ? (pkgJson.contributes.iconThemes as unknown as Array<Record<string, unknown>>)
    : []
  const vscodeIconThemes = rawIconThemes
    .filter((t) => t && typeof t.id === "string" && typeof t.path === "string")
    .map((t) => ({
      id: t.id as string,
      label: typeof t.label === "string" ? t.label : (t.id as string),
      path: t.path as string,
    }))

  const rawSnippets = Array.isArray(pkgJson.contributes?.snippets)
    ? (pkgJson.contributes.snippets as unknown as Array<Record<string, unknown>>)
    : []
  const vscodeSnippets = rawSnippets
    .filter((sn) => sn && typeof sn.language === "string" && typeof sn.path === "string")
    .map((sn) => ({ language: sn.language as string, path: sn.path as string }))

  // ── Settings contributed via VS Code ──────────────────────────────────
  const configSchema = vscodeConfigurationToSchema(pkgJson.contributes, nls, warnings)

  // ── Final cognia manifest ─────────────────────────────────────────────
  const manifest: PluginManifest = {
    id,
    name: displayName,
    version: pkgJson.version,
    description,
    ...(nameKey !== undefined && hasNlsLocales ? { nameKey } : {}),
    ...(descriptionKey !== undefined && hasNlsLocales ? { descriptionKey } : {}),
    ...(hasNlsLocales && (nameKey !== undefined || descriptionKey !== undefined)
      ? { i18n: { locales: pickNlsKeys(nls.locales, [nameKey, descriptionKey]) } }
      : {}),
    ...(configSchema ? { configSchema } : {}),
    type: "vscode-extension",
    capabilities,
    author,
    permissions,
    ...(license !== undefined ? { license } : {}),
    ...(homepage !== undefined ? { homepage } : {}),
    ...(repository !== undefined ? { repository } : {}),
    ...(keywords !== undefined && keywords.length > 0 ? { keywords } : {}),
    ...(typeof pkgJson.icon === "string" ? { icon: pkgJson.icon } : {}),
    activationEvents: cogniaActivation,
    vscodeMain: pkgJson.main,
    vscodeExtension: vscodeExtensionBlock,
    runtimeCompatibility: {
      tauri: { availability: "supported" },
      // Themes-only extensions can run in browser; everything else requires
      // the Node sidecar. We surface "blocked" for the browser when a main
      // bundle is declared, "supported" otherwise.
      browser: pkgJson.main
        ? {
            availability: "blocked",
            reason: "VS Code extensions with a main bundle require the Tauri desktop runtime.",
          }
        : { availability: "supported" },
    },
    ...(themes.length > 0 ? { themes } : {}),
    ...(vscodeLanguages.length > 0 ? { vscodeLanguages } : {}),
    ...(vscodeGrammars.length > 0 ? { vscodeGrammars } : {}),
    ...(vscodeIconThemes.length > 0 ? { vscodeIconThemes } : {}),
    ...(vscodeSnippets.length > 0 ? { vscodeSnippets } : {}),
  }

  return {
    manifest,
    vscodeManifest: pkgJson,
    permissions: inference,
    lspBinaryCandidates: vsix.lspBinaryCandidates,
    warnings,
  }
}

/** Only the strings the manifest names, from each locale's bundle. */
function pickNlsKeys(
  locales: Record<string, Record<string, string>>,
  keys: Array<string | undefined>
): Record<string, Record<string, string>> {
  const wanted = keys.filter((key): key is string => key !== undefined)
  const out: Record<string, Record<string, string>> = {}
  for (const [locale, bundle] of Object.entries(locales)) {
    const picked = Object.fromEntries(
      wanted.filter((key) => typeof bundle[key] === "string").map((key) => [key, bundle[key]])
    )
    if (Object.keys(picked).length > 0) out[locale] = picked
  }
  return out
}

/**
 * Build the canonical cognia plugin id. Strips characters that would break
 * Dexie namespacing or filesystem paths.
 */
function canonicalId(pkgJson: VsCodeManifest): string {
  // Delegates to the shared rule so this stays in lockstep with
  // `sanitize_plugin_id_strict` on the Rust side — the id is both a Dexie key
  // and a directory name, and a drift between the two means the row and the
  // directory stop describing the same extension.
  //
  // The previous rule here rewrote hostile characters to `-` but preserved
  // `.`, so `publisher: ""` + `name: "."` composed into `".."` — a traversing
  // path component. `canonicalExtensionId` rejects instead of rewriting.
  return canonicalExtensionId(pkgJson.publisher, pkgJson.name)
}

function resolveRepositoryUrl(repo: VsCodeManifest["repository"]): string | undefined {
  if (typeof repo === "string") return repo
  if (repo && typeof repo === "object" && typeof repo.url === "string") return repo.url
  return undefined
}

/**
 * VS Code activation events with no Cognia trigger. An extension does not
 * start for them; they are recorded in `vscodeExtension.unsupportedActivationEvents`
 * and shown on the extension's card.
 */
export const UNSUPPORTED_VSCODE_ACTIVATION_PREFIXES: readonly string[] = [
  "onDebug",
  "onWebviewPanel:",
  "onCustomEditor:",
  "onTaskType:",
  "onFileSystem:",
  "onTerminal",
  "onNotebook:",
  "onRenderer:",
  "onSearch:",
  "onWalkthrough:",
  "onChatParticipant:",
  "onLanguageModelTool:",
  "onEditSession",
  "onIssueReporterOpened",
  "onOpenExternalUri",
]

/**
 * Translate one VS Code activation event into the event Cognia fires for it.
 * Returns `undefined` (with a warning) for one Cognia never fires.
 *
 * - `*` and `onStartupFinished` start the extension at launch.
 * - `onView:<id>` also starts it at launch: Cognia shows an extension's views
 *   only once it is running, so there is no view to open before that.
 * - `onCommand:`, `onLanguage:`, `workspaceContains:`, `onUri` and
 *   `onAuthenticationRequest` start it when they happen.
 */
export function mapActivationEvent(
  event: string,
  warnings: string[]
): ActivationEventDeclaration | undefined {
  if (event === "*" || event === "onStartupFinished") return "startup"
  if (event === "onUri") return "onUri"
  if (event === "onAuthenticationRequest") return "onAuthenticationRequest"
  if (event.startsWith("onAuthenticationRequest:") && event.length > 24) {
    return event as ActivationEventDeclaration
  }
  if (
    (event.startsWith("onCommand:") ||
      event.startsWith("onLanguage:") ||
      event.startsWith("workspaceContains:")) &&
    !event.endsWith(":")
  ) {
    return event as ActivationEventDeclaration
  }
  if (event.startsWith("onView:")) {
    warnings.push(
      `"${event}" starts the extension at launch: Cognia shows an extension's views only once it is running.`
    )
    return "startup"
  }
  warnings.push(
    UNSUPPORTED_VSCODE_ACTIVATION_PREFIXES.some((prefix) => event.startsWith(prefix))
      ? `Activation event "${event}" is not supported in Cognia; the extension does not start for it.`
      : `Unknown VS Code activation event "${event}"; the extension does not start for it.`
  )
  return undefined
}

/**
 * The events that start an extension in Cognia, and the declared ones that
 * never will.
 *
 * VS Code (1.74 and later) adds events implied by contributions, and so do
 * we: `onCommand:` for each contributed command, `onLanguage:` for each
 * contributed language, `onAuthenticationRequest:` for each authentication
 * provider, and launch for contributed views (see `mapActivationEvent`).
 *
 * An extension left with no event at all and no unsupported one starts at
 * launch: one without code has only declarative contributions, which Cognia
 * applies while the extension is enabled, and one with code would otherwise
 * never run. One whose only events are unsupported does not start.
 */
export function planVscodeActivation(
  pkgJson: VsCodeManifest,
  warnings: string[]
): { events: ActivationEventDeclaration[]; unsupported: string[] } {
  const events: ActivationEventDeclaration[] = []
  const unsupported: string[] = []
  const add = (event: ActivationEventDeclaration) => {
    if (!events.includes(event)) events.push(event)
  }
  const declared = Array.isArray(pkgJson.activationEvents) ? pkgJson.activationEvents : []
  for (const event of declared) {
    if (typeof event !== "string") continue
    const mapped = mapActivationEvent(event, warnings)
    if (mapped) add(mapped)
    else if (!unsupported.includes(event)) unsupported.push(event)
  }

  const contributes = pkgJson.contributes
  if (contributes && typeof contributes === "object") {
    for (const command of Array.isArray(contributes.commands) ? contributes.commands : []) {
      if (typeof command?.command === "string" && command.command) {
        add(`onCommand:${command.command}`)
      }
    }
    for (const language of Array.isArray(contributes.languages) ? contributes.languages : []) {
      const id = (language as { id?: unknown } | null)?.id
      if (typeof id === "string" && id) add(`onLanguage:${id}`)
    }
    for (const provider of Array.isArray(contributes.authentication)
      ? contributes.authentication
      : []) {
      if (typeof provider?.id === "string" && provider.id) {
        add(`onAuthenticationRequest:${provider.id}` as ActivationEventDeclaration)
      }
    }
    const views =
      contributes.views && typeof contributes.views === "object" ? contributes.views : {}
    if (Object.values(views).some((list) => Array.isArray(list) && list.length > 0)) {
      add("startup")
    }
  }

  if (events.length === 0 && unsupported.length === 0) add("startup")
  return { events, unsupported }
}

/**
 * `contributes.commands` as Cognia lists them before the extension runs:
 * titles and categories resolved from `package.nls.json`, and the `when`
 * clause of the command's `menus.commandPalette` entry (`"false"` hides it).
 */
export function vscodeContributedCommands(
  pkgJson: VsCodeManifest,
  nls: Parameters<typeof resolveNls>[1]
): VsCodeContributedCommand[] {
  const contributes = pkgJson.contributes
  const commands = Array.isArray(contributes?.commands) ? contributes.commands : []
  const palette = Array.isArray(contributes?.menus?.commandPalette)
    ? contributes.menus.commandPalette
    : []
  const result: VsCodeContributedCommand[] = []
  for (const entry of commands) {
    if (typeof entry?.command !== "string" || !entry.command) continue
    if (result.some((existing) => existing.command === entry.command)) continue
    const title =
      typeof entry.title === "string" && entry.title ? resolveNls(entry.title, nls) : entry.command
    const category =
      typeof entry.category === "string" && entry.category
        ? resolveNls(entry.category, nls)
        : undefined
    const when = palette.find((item) => item?.command === entry.command)?.when
    result.push({
      command: entry.command,
      title,
      ...(category ? { category } : {}),
      ...(typeof when === "string" && when ? { when } : {}),
    })
  }
  return result
}

/** A contribution list with at least one entry (VS Code also accepts a lone object for some). */
function hasEntries(value: unknown): boolean {
  if (Array.isArray(value)) return value.length > 0
  return Boolean(value) && typeof value === "object"
}

/**
 * What the extension contributes, or how it is built, that Cognia does not
 * provide (`VsCodeUnsupportedContribution` documents each), the ones that
 * stop the extension from working first.
 */
export function vscodeUnsupportedContributions(
  pkgJson: VsCodeManifest,
  bundleFormat: VsCodeExtensionBlock["bundleFormat"] | null
): VsCodeUnsupportedContribution[] {
  const c =
    pkgJson.contributes && typeof pkgJson.contributes === "object" ? pkgJson.contributes : {}
  const found = new Set<VsCodeUnsupportedContribution>()
  if (hasEntries(c.debuggers) || hasEntries(c.breakpoints)) found.add("debuggers")
  if (hasEntries(c.notebooks) || hasEntries(c.notebookRenderer)) found.add("notebooks")
  const menus = c.menus && typeof c.menus === "object" ? c.menus : {}
  if (
    Object.entries(menus).some(([menu, items]) => menu !== "commandPalette" && hasEntries(items))
  ) {
    found.add("menus")
  }
  if (hasEntries(c.keybindings)) found.add("keybindings")
  const views = c.views && typeof c.views === "object" ? c.views : {}
  const containers =
    c.viewsContainers && typeof c.viewsContainers === "object" ? c.viewsContainers : {}
  if (
    Object.values(views).some(
      (list) =>
        Array.isArray(list) &&
        list.some((view) => (view as { type?: unknown } | null)?.type !== "webview")
    ) ||
    Object.values(containers).some(hasEntries) ||
    hasEntries(c.viewsWelcome)
  ) {
    found.add("views")
  }
  if (hasEntries(c.grammars)) found.add("editor-grammars")
  if (Array.isArray(pkgJson.extensionPack) && pkgJson.extensionPack.length > 0) {
    found.add("extension-pack")
  }
  if (bundleFormat === "esm") found.add("esm-bundle")
  return UNSUPPORTED_CONTRIBUTION_ORDER.filter((kind) => found.has(kind))
}

/** An ES module cannot start at all; a missing debugger or view loses a whole feature; the rest lose a way in. */
const UNSUPPORTED_CONTRIBUTION_ORDER: readonly VsCodeUnsupportedContribution[] = [
  "esm-bundle",
  "debuggers",
  "notebooks",
  "views",
  "menus",
  "keybindings",
  "editor-grammars",
  "extension-pack",
]

/**
 * Map VS Code contributions to the cognia `PluginCapability[]` list. The
 * cognia plugin manager uses this to gate registry hooks (e.g. `themes`
 * capability → themes-bridge runs; `commands` capability → command
 * registry binds).
 */
function inferCapabilities(pkgJson: VsCodeManifest): PluginCapability[] {
  const c = pkgJson.contributes
  const out = new Set<PluginCapability>()
  // Bundled extension code always counts as a "tools" provider since
  // commands, tasks, providers, etc. all need a bundle to run.
  if (typeof pkgJson.main === "string") out.add("tools")
  if (!c) return [...out]
  if (Array.isArray(c.commands) && c.commands.length > 0) out.add("commands")
  if (Array.isArray(c.themes) && c.themes.length > 0) out.add("themes")
  if (Array.isArray(c.iconThemes) && c.iconThemes.length > 0) out.add("themes")
  // W5.1 — grammar/snippet-only extensions ride the appearance capability
  // (like icon themes) so a bundle-less contribution still yields a
  // non-empty capability set.
  if (Array.isArray(c.grammars) && c.grammars.length > 0) out.add("themes")
  if (Array.isArray(c.snippets) && c.snippets.length > 0) out.add("themes")
  if (Array.isArray(c.productIconThemes) && c.productIconThemes.length > 0) out.add("themes")
  if (Array.isArray(c.chatParticipants) && c.chatParticipants.length > 0) out.add("modes")
  if (Array.isArray(c.mcpServerDefinitionProviders) && c.mcpServerDefinitionProviders.length > 0) {
    out.add("mcp-server-preset")
  }
  if (Array.isArray(c.authentication) && c.authentication.length > 0) out.add("providers")
  if (Array.isArray(c.taskDefinitions) && c.taskDefinitions.length > 0) out.add("scheduler")
  return [...out]
}
