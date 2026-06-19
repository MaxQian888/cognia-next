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
 *   • Activation events flow through `mapActivationEvent` which rewrites
 *     `onLanguage:*` (deprecated in cognia) to `startup` (with the original
 *     events preserved in `vscodeExtension.activationEvents`).
 *   • Synthetic id is always `publisher.name`. The sidecar uses this same id
 *     to namespace storage, secrets, and Dexie tables.
 */

import type { PluginManifest, PluginCapability, PluginPermission } from "@/types/plugin/plugin"
import type {
  VsCodeManifest,
  VsCodeActivationEvent,
  VsCodeExtensionAdapterResult,
  VsCodeExtensionBlock,
  VsCodePermissionInference,
} from "@/types/plugin/plugin-vscode"
import type { ActivationEventDeclaration } from "@/lib/plugin/contracts/plugin-points"
import type { VsixInstallResult } from "./vsix-installer"

export interface AdaptVscodeManifestInput {
  /** Output of `installVsix`. */
  vsix: VsixInstallResult
  /** Output of `inferPermissions` (Phase M0 / Task #13). */
  inference: VsCodePermissionInference
  /** Install source. Use `"vsix-upload"` for drag-drop, `"openvsx"` for registry. */
  source: VsCodeExtensionBlock["source"]
}

/**
 * Translate a parsed VS Code extension into a cognia `PluginManifest`.
 *
 * Returns the synthesised manifest, the original VS Code manifest verbatim,
 * the inference result, the LSP binary candidates, and any non-fatal
 * warnings the adapter emitted during translation.
 */
export function adaptVscodeManifest(input: AdaptVscodeManifestInput): VsCodeExtensionAdapterResult {
  const { vsix, inference, source } = input
  const { pkgJson } = vsix
  const warnings: string[] = []

  const id = canonicalId(pkgJson)
  const displayName =
    typeof pkgJson.displayName === "string" && pkgJson.displayName.length > 0
      ? pkgJson.displayName
      : pkgJson.name
  const description = typeof pkgJson.description === "string" ? pkgJson.description : displayName
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
  const cogniaActivation: ActivationEventDeclaration[] = []
  for (const ev of rawActivation) {
    const mapped = mapActivationEvent(ev, warnings)
    if (mapped && !cogniaActivation.includes(mapped)) {
      cogniaActivation.push(mapped)
    }
  }
  // If the extension declares no activation events at all, VS Code 1.74+
  // implicitly activates on first matching contribution. We mirror that by
  // adding `startup` so the sidecar at least loads it on app start.
  if (cogniaActivation.length === 0 && hasAnyContribution(pkgJson)) {
    cogniaActivation.push("startup")
  }

  // ── Capabilities ──────────────────────────────────────────────────────
  const capabilities = inferCapabilities(pkgJson)

  // ── Permissions ───────────────────────────────────────────────────────
  // Static-analysis permissions become the manifest's required set.
  // Optional permissions stay empty — the sidecar's runtime gate handles
  // permission upgrades on first sensitive `require()` call.
  const permissions: PluginPermission[] = [...new Set(inference.permissions)]

  // ── vscodeExtension block ─────────────────────────────────────────────
  const vscodeExtensionBlock: VsCodeExtensionBlock = {
    identifier: id,
    version: pkgJson.version,
    engineVscode: pkgJson.engines?.vscode ?? "*",
    vsixSha256: vsix.sha256,
    source,
    bundleFormat: vsix.bundleFormat ?? "cjs",
    activationEvents: rawActivation as VsCodeActivationEvent[],
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

  // ── Final cognia manifest ─────────────────────────────────────────────
  const manifest: PluginManifest = {
    id,
    name: displayName,
    version: pkgJson.version,
    description,
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
  }

  return {
    manifest,
    vscodeManifest: pkgJson,
    permissions: inference,
    lspBinaryCandidates: vsix.lspBinaryCandidates,
    warnings,
  }
}

/**
 * Build the canonical cognia plugin id. Strips characters that would break
 * Dexie namespacing or filesystem paths.
 */
function canonicalId(pkgJson: VsCodeManifest): string {
  const safe = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, "-")
  return `${safe(pkgJson.publisher)}.${safe(pkgJson.name)}`
}

function resolveRepositoryUrl(repo: VsCodeManifest["repository"]): string | undefined {
  if (typeof repo === "string") return repo
  if (repo && typeof repo === "object" && typeof repo.url === "string") return repo.url
  return undefined
}

/**
 * Whether the manifest declares anything that would trigger implicit VS Code
 * activation (1.74+). If yes, the adapter inserts a `startup` event when
 * the manifest left `activationEvents` empty.
 */
function hasAnyContribution(pkgJson: VsCodeManifest): boolean {
  return Boolean(
    pkgJson.contributes &&
    typeof pkgJson.contributes === "object" &&
    Object.keys(pkgJson.contributes).length > 0
  )
}

/**
 * Translate one VS Code activation event into a cognia
 * `ActivationEventDeclaration`. Returns `undefined` to skip an event the
 * cognia registry has no slot for (the original event is still preserved
 * in `vscodeExtension.activationEvents`).
 *
 * - `*` (eager) → `startup`
 * - `onLanguage:*` (cognia-deprecated) → `startup` + warning
 * - VS Code patterns with a 1:1 cognia analogue pass through unchanged.
 */
export function mapActivationEvent(
  event: string,
  warnings: string[]
): ActivationEventDeclaration | undefined {
  if (event === "*") return "startup"
  if (event === "onStartupFinished") return "onStartupFinished"
  if (event === "onAuthenticationRequest") return "onAuthenticationRequest"
  if (event === "onUri") return "onUri"
  if (event === "onTerminal") return "onTerminal"

  if (event.startsWith("onLanguage:") && event !== "onLanguage:*") {
    // cognia's onLanguage:* is deprecated; rewrite to startup. The original
    // event remains in vscodeExtension.activationEvents so the sidecar can
    // still match against `vscode.languages.onDidChangeActiveTextEditor`.
    warnings.push(
      `onLanguage activation rewritten to startup for "${event}" (cognia deprecates onLanguage:*).`
    )
    return "startup"
  }

  if (event.startsWith("onCommand:")) return event as ActivationEventDeclaration
  if (event.startsWith("onView:")) return event as ActivationEventDeclaration
  if (event.startsWith("onWebviewPanel:")) return event as ActivationEventDeclaration
  if (event.startsWith("onCustomEditor:")) return event as ActivationEventDeclaration
  if (event.startsWith("onTaskType:")) return event as ActivationEventDeclaration
  if (event.startsWith("onFileSystem:")) return event as ActivationEventDeclaration
  if (event.startsWith("onDebug")) {
    // Collapse all onDebug* variants to onDebugResolve:* (validator-friendly).
    if (event === "onDebug" || event === "onDebugAdapterProtocolTracker") {
      warnings.push(
        `Debug activation event "${event}" mapped to onDebugResolve:* — cognia raises NotSupportedError at runtime.`
      )
      return "onDebugResolve:*"
    }
    if (
      event.startsWith("onDebugResolve:") ||
      event.startsWith("onDebugInitialConfigurations") ||
      event.startsWith("onDebugDynamicConfigurations")
    ) {
      return "onDebugResolve:*"
    }
  }
  if (event.startsWith("onTerminalProfile:")) return event as ActivationEventDeclaration
  if (event.startsWith("onNotebook:")) return event as ActivationEventDeclaration
  if (event.startsWith("onWalkthrough:")) return event as ActivationEventDeclaration
  if (event.startsWith("onChatParticipant:")) return event as ActivationEventDeclaration
  if (event.startsWith("onLanguageModelTool:")) return event as ActivationEventDeclaration
  if (event.startsWith("workspaceContains:")) return event as ActivationEventDeclaration

  // Unknown event — the sidecar still receives it via vscodeExtension.activationEvents.
  warnings.push(
    `Unknown VS Code activation event "${event}" — preserved verbatim for the sidecar but not advertised to cognia.`
  )
  return undefined
}

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
  if (Array.isArray(c.productIconThemes) && c.productIconThemes.length > 0) out.add("themes")
  if (Array.isArray(c.chatParticipants) && c.chatParticipants.length > 0) out.add("modes")
  if (Array.isArray(c.mcpServerDefinitionProviders) && c.mcpServerDefinitionProviders.length > 0) {
    out.add("mcp-server-preset")
  }
  if (Array.isArray(c.authentication) && c.authentication.length > 0) out.add("providers")
  if (Array.isArray(c.taskDefinitions) && c.taskDefinitions.length > 0) out.add("scheduler")
  return [...out]
}
