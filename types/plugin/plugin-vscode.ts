/**
 * VS Code Extension type definitions — used by the VS Code Extension Reuse
 * compatibility layer (see `docs/content/docs/en/adr/00xx-vscode-extension-reuse.md`,
 * tracked in `~/.claude/plans/vscode-snug-squid.md`).
 *
 * These types model the public surface of a VS Code extension's
 * `package.json` so the manifest adapter
 * (`lib/plugin/vscode-shim/manifest-adapter.ts`) can translate any well-formed
 * `.vsix` into a cognia `PluginManifest` without simplifying contribution
 * points away.
 *
 * Source for the field set: https://code.visualstudio.com/api/references/contribution-points
 * Source for activation events: https://code.visualstudio.com/api/references/activation-events
 *
 * Field naming follows the VS Code spec verbatim — these are not cognia types,
 * they are pass-through types that mirror an external system. Do NOT rename
 * fields to fit cognia naming; the adapter relies on lossless parsing.
 */

import type { PluginManifest, PluginPermission } from "./plugin"

// =============================================================================
// VS Code activation events
// =============================================================================

/**
 * The full set of VS Code activation event patterns. Each pattern is either a
 * fixed string (e.g. `"onStartupFinished"`) or a prefix-and-suffix template
 * (e.g. `"onCommand:editor.action.formatDocument"`). The empty `"*"` form is
 * supported but discouraged.
 */
export type VsCodeActivationEvent =
  // Bare events
  | "*"
  | "onStartupFinished"
  | "onDebug"
  | "onDebugAdapterProtocolTracker"
  | "onDebugDynamicConfigurations"
  | "onDebugInitialConfigurations"
  | "onTerminal"
  | "onEditSession"
  | "onIssueReporterOpened"
  | "onOpenExternalUri"
  | "onAuthenticationRequest"
  | "onUri"
  // Prefixed events — string template, runtime-validated
  | `onLanguage:${string}`
  | "onLanguage"
  | `onCommand:${string}`
  | `onView:${string}`
  | `onWebviewPanel:${string}`
  | `onCustomEditor:${string}`
  | `onTaskType:${string}`
  | `onFileSystem:${string}`
  | `onDebugResolve:${string}`
  | `onTerminalProfile:${string}`
  | `onTerminalShellIntegration:${string}`
  | `onNotebook:${string}`
  | `onRenderer:${string}`
  | `onSearch:${string}`
  | `onWalkthrough:${string}`
  | `onChatParticipant:${string}`
  | `onLanguageModelTool:${string}`
  | `workspaceContains:${string}`

// =============================================================================
// VS Code contribution points — the full `contributes.*` block
// =============================================================================

export interface VsCodeCommandContribution {
  command: string
  title: string
  category?: string
  icon?: string | { light: string; dark: string }
  enablement?: string
  shortTitle?: string
}

export interface VsCodeMenuItem {
  command?: string
  submenu?: string
  when?: string
  group?: string
  alt?: string
}

export interface VsCodeKeybinding {
  command: string
  key: string
  mac?: string
  linux?: string
  win?: string
  when?: string
  args?: unknown
}

export interface VsCodeConfigurationProperty {
  type: "string" | "number" | "boolean" | "array" | "object" | "null" | string[]
  default?: unknown
  description?: string
  markdownDescription?: string
  enum?: unknown[]
  enumDescriptions?: string[]
  pattern?: string
  format?: string
  minimum?: number
  maximum?: number
  scope?:
    | "application"
    | "machine"
    | "machine-overridable"
    | "window"
    | "resource"
    | "language-overridable"
  order?: number
  deprecationMessage?: string
  markdownDeprecationMessage?: string
  items?: VsCodeConfigurationProperty
  properties?: Record<string, VsCodeConfigurationProperty>
  additionalProperties?: boolean | VsCodeConfigurationProperty
}

export interface VsCodeConfigurationSection {
  type?: "object"
  title?: string
  order?: number
  properties: Record<string, VsCodeConfigurationProperty>
}

export interface VsCodeLanguage {
  id: string
  aliases?: string[]
  extensions?: string[]
  filenames?: string[]
  filenamePatterns?: string[]
  firstLine?: string
  mimetypes?: string[]
  configuration?: string
  icon?: { light: string; dark: string }
}

export interface VsCodeGrammar {
  language?: string
  scopeName: string
  path: string
  embeddedLanguages?: Record<string, string>
  tokenTypes?: Record<string, "other" | "comment" | "string">
  injectTo?: string[]
  balancedBracketScopes?: string[]
  unbalancedBracketScopes?: string[]
}

export interface VsCodeThemeContribution {
  label: string
  uiTheme: "vs" | "vs-dark" | "hc-black" | "hc-light"
  path: string
  id?: string
}

export interface VsCodeIconTheme {
  id: string
  label: string
  path: string
}

export interface VsCodeProductIconTheme {
  id: string
  label: string
  path: string
}

export interface VsCodeSnippet {
  language: string
  path: string
}

export interface VsCodeJsonValidation {
  fileMatch: string | string[]
  url: string
}

export interface VsCodeView {
  id: string
  name: string
  when?: string
  icon?: string
  contextualTitle?: string
  type?: "tree" | "webview"
  initialSize?: number
  visibility?: "visible" | "hidden" | "collapsed"
  accessibilityHelpContent?: string
}

export interface VsCodeViewsContainer {
  id: string
  title: string
  icon: string
}

export interface VsCodeViewsWelcome {
  view: string
  contents: string
  when?: string
  group?: string
  enablement?: string
}

export interface VsCodeWalkthrough {
  id: string
  title: string
  description: string
  steps: Array<{
    id: string
    title: string
    description?: string
    media: { image?: string; markdown?: string; altText?: string; svg?: string }
    completionEvents?: string[]
    when?: string
  }>
  when?: string
  featuredFor?: string[]
}

export interface VsCodeCustomEditor {
  viewType: string
  displayName: string
  selector: Array<{ filenamePattern: string }>
  priority?: "default" | "builtin" | "option"
}

export interface VsCodeDebugger {
  type: string
  label: string
  program?: string
  runtime?: string
  configurationAttributes?: Record<string, unknown>
  initialConfigurations?: Array<Record<string, unknown>>
  configurationSnippets?: Array<Record<string, unknown>>
  variables?: Record<string, string>
  languages?: string[]
  when?: string
}

export interface VsCodeBreakpoint {
  language: string
}

export interface VsCodeColor {
  id: string
  description: string
  defaults: { light: string; dark: string; highContrast?: string; highContrastLight?: string }
}

export interface VsCodeProblemMatcher {
  name: string
  label?: string
  owner?: string
  pattern?: string | unknown[]
  background?: { activeOnStart?: boolean; beginsPattern?: string; endsPattern?: string }
  fileLocation?: string | string[]
  severity?: "error" | "warning" | "info"
  source?: string
}

export interface VsCodeProblemPattern {
  name: string
  regexp: string
  file?: number
  line?: number
  column?: number
  endLine?: number
  endColumn?: number
  severity?: number
  code?: number
  message?: number
  location?: number
  loop?: boolean
  kind?: "file" | "location"
}

export interface VsCodeTaskDefinition {
  type: string
  required?: string[]
  properties?: Record<string, VsCodeConfigurationProperty>
  when?: string
}

export interface VsCodeTerminalProfile {
  id: string
  title?: string
  icon?: string
}

export interface VsCodeNotebookContribution {
  type: string
  displayName: string
  selector: Array<{ filenamePattern?: string; excludeFileNamePattern?: string }>
  priority?: "default" | "option"
}

export interface VsCodeNotebookRendererContribution {
  id: string
  displayName: string
  mimeTypes?: string[]
  entrypoint: string | { extends: string; path: string }
  dependencies?: string[]
  optionalDependencies?: string[]
  requiresMessaging?: "always" | "optional" | "never"
}

export interface VsCodeNotebookPreloadContribution {
  type: string
  entrypoint: string
  localResourceRoots?: string[]
}

export interface VsCodeAuthentication {
  id: string
  label: string
}

export interface VsCodeSemanticTokenType {
  id: string
  description: string
  superType?: string
}

export interface VsCodeSemanticTokenModifier {
  id: string
  description: string
}

export interface VsCodeSemanticTokenScope {
  language?: string
  scopes: Record<string, string[]>
}

export interface VsCodeMcpServerDefinitionProvider {
  id: string
  label?: string
}

export interface VsCodeChatParticipant {
  id: string
  fullName: string
  name: string
  description?: string
  isSticky?: boolean
  commands?: Array<{ name: string; description: string; isSticky?: boolean }>
  when?: string
}

export interface VsCodeLanguageModelToolSet {
  name: string
  description: string
  icon?: string
  tools: string[]
}

export interface VsCodeSpeechProvider {
  name: string
  description?: string
}

export interface VsCodeLocalization {
  languageId: string
  languageName?: string
  localizedLanguageName?: string
  translations: Array<{ id: string; path: string }>
}

export interface VsCodeChatAgent {
  path: string
  when?: string
  sessionTypes?: string[]
}

export interface VsCodeLanguageModelChatProvider {
  vendor: string
  displayName: string
  configuration?: Record<string, unknown>
  managementCommand?: string
  when?: string
}

export interface VsCodeIcon {
  description: string
  default: { fontPath?: string; fontCharacter?: string } | { fontId: string } | string
}

export interface VsCodeSubmenu {
  id: string
  label: string
  icon?: string | { light: string; dark: string }
}

export interface VsCodeResourceLabelFormatter {
  scheme: string
  authority?: string
  formatting: {
    label?: string
    separator?: string
    tildify?: boolean
    workspaceSuffix?: string
    authorityPrefix?: string
  }
}

export interface VsCodeTypescriptServerPlugin {
  name: string
  enableForWorkspaceTypeScriptVersions?: boolean
  configNamespace?: string
  languages?: string[]
}

/**
 * The full `contributes` block in a VS Code `package.json`.
 *
 * Every field listed here corresponds to a documented contribution point on
 * https://code.visualstudio.com/api/references/contribution-points . Unknown
 * fields are preserved by the adapter via the index signature so future
 * additions don't silently drop.
 */
export interface VsCodeContributions {
  // Commands & menus
  commands?: VsCodeCommandContribution[]
  menus?: Record<string, VsCodeMenuItem[]>
  submenus?: VsCodeSubmenu[]
  keybindings?: VsCodeKeybinding[]

  // Configuration
  configuration?: VsCodeConfigurationSection | VsCodeConfigurationSection[]
  configurationDefaults?: Record<string, unknown>
  jsonValidation?: VsCodeJsonValidation[]

  // Languages & grammars
  languages?: VsCodeLanguage[]
  grammars?: VsCodeGrammar[]
  snippets?: VsCodeSnippet[]
  semanticTokenTypes?: VsCodeSemanticTokenType[]
  semanticTokenModifiers?: VsCodeSemanticTokenModifier[]
  semanticTokenScopes?: VsCodeSemanticTokenScope[]

  // Themes & icons
  themes?: VsCodeThemeContribution[]
  iconThemes?: VsCodeIconTheme[]
  productIconThemes?: VsCodeProductIconTheme[]
  colors?: VsCodeColor[]
  icons?: Record<string, VsCodeIcon>

  // UI surface
  views?: Record<string, VsCodeView[]>
  viewsContainers?: Record<"activitybar" | "panel", VsCodeViewsContainer[]>
  viewsWelcome?: VsCodeViewsWelcome[]
  walkthroughs?: VsCodeWalkthrough[]

  // Custom editors / debuggers / tasks / terminal
  customEditors?: VsCodeCustomEditor[]
  notebooks?: VsCodeNotebookContribution[]
  notebookRenderer?: VsCodeNotebookRendererContribution[]
  debuggers?: VsCodeDebugger[]
  breakpoints?: VsCodeBreakpoint[]
  taskDefinitions?: VsCodeTaskDefinition[]
  problemMatchers?: VsCodeProblemMatcher[]
  problemPatterns?: VsCodeProblemPattern[]
  terminal?: { profiles?: VsCodeTerminalProfile[] }

  // Authentication, AI & MCP
  authentication?: VsCodeAuthentication[]
  chatParticipants?: VsCodeChatParticipant[]
  chatAgents?: VsCodeChatAgent[]
  languageModelChatProviders?: VsCodeLanguageModelChatProvider[]
  mcpServerDefinitionProviders?: VsCodeMcpServerDefinitionProvider[]
  chatInstructions?: Array<{ path: string }>
  chatPromptFiles?: Array<{ path: string }>
  chatSkills?: Array<{ path: string; when?: string }>
  languageModelTools?: Array<{
    name: string
    displayName?: string
    modelDescription?: string
    userDescription?: string
    toolReferenceName?: string
    icon?: string
    tags?: string[]
    when?: string
    canBeReferencedInPrompt?: boolean
    inputSchema?: unknown
  }>
  localizations?: VsCodeLocalization[]

  // Misc
  resourceLabelFormatters?: VsCodeResourceLabelFormatter[]
  typescriptServerPlugins?: VsCodeTypescriptServerPlugin[]

  /** Forward-compatible escape hatch — unknown contributions pass through. */
  [key: string]: unknown
}

// =============================================================================
// VS Code `package.json` top-level shape
// =============================================================================

/**
 * The subset of fields a VS Code extension's `package.json` declares. Adapter
 * tolerates extra fields (preserved through the index signature).
 */
export interface VsCodeManifest {
  /** Extension name; combined with `publisher` to form the canonical id. */
  name: string

  /** Publisher namespace. Combined with `name` → canonical id `publisher.name`. */
  publisher: string

  /** Semver version. */
  version: string

  /** Human-readable display name (falls back to `name`). */
  displayName?: string

  /** Plain-text description. */
  description?: string

  /** Categories shown on the marketplace. */
  categories?: string[]

  /** Search keywords. */
  keywords?: string[]

  /** SPDX license id. */
  license?: string

  /** Marketplace icon path (relative to extension root). */
  icon?: string

  /** Galleries / preview badges. */
  preview?: boolean

  /** Repository URL. */
  repository?: string | { type: string; url: string }

  /** Homepage URL. */
  homepage?: string

  /** Bug-report URL. */
  bugs?: string | { url: string; email?: string }

  /**
   * Engine compatibility. `vscode` constraint is mandatory in VS Code; cognia's
   * adapter ignores it for routing (every extension runs through the sidecar),
   * but it is preserved on the cognia manifest for telemetry / display.
   */
  engines: {
    vscode: string
    node?: string
  }

  /**
   * Activation events. Empty / missing array means VS Code uses the
   * contribution-driven implicit activation (1.74+).
   */
  activationEvents?: VsCodeActivationEvent[]

  /** Node.js CJS entry point. Mutually optional with `browser`. */
  main?: string

  /** Browser web-host entry point. */
  browser?: string

  /** Contribution points. */
  contributes?: VsCodeContributions

  /** Extension dependencies (publisher.name strings). */
  extensionDependencies?: string[]

  /** Bundled extension pack. */
  extensionPack?: string[]

  /** What kind of host the extension can run in. */
  extensionKind?: Array<"ui" | "workspace" | "web">

  /** Workspace trust capabilities. */
  capabilities?: {
    untrustedWorkspaces?: { supported: boolean | "limited"; description?: string }
    virtualWorkspaces?: boolean | { supported: boolean | "limited"; description?: string }
  }

  /** Prerelease flag. */
  preRelease?: boolean

  /** Proposed-API allowlist. */
  enabledApiProposals?: string[]

  /** L10N bundle directory (relative to extension root). */
  l10n?: string

  /** Sponsorship link. */
  sponsor?: { url: string }

  /** Marketplace q&a link. */
  qna?: string | false

  /** Galleries badges. */
  badges?: Array<{ url: string; href: string; description: string }>

  /** Preserve unknown top-level keys. */
  [key: string]: unknown
}

// =============================================================================
// Adapter output
// =============================================================================

/**
 * Result of running the VS Code → cognia manifest adapter.
 *
 * - `manifest` is the synthesised cognia `PluginManifest` ready for the
 *   existing plugin manager.
 * - `vscodeManifest` is the original VS Code `package.json` preserved verbatim
 *   so the runtime can re-consult contribution points (the cognia manifest is
 *   intentionally lossy on VS Code-specific fields the cognia type system has
 *   no slot for).
 * - `permissions` is the static-analysis result; the sidecar's runtime gate
 *   may add more permissions on first use.
 * - `lspBinaryCandidates` enumerates executable files inside the `.vsix` that
 *   `lib/plugin/vscode-shim/lsp-binary-policy.ts` will adjudicate against
 *   the trusted-publisher ledger.
 */
export interface VsCodeExtensionAdapterResult {
  manifest: PluginManifest
  vscodeManifest: VsCodeManifest
  permissions: VsCodePermissionInference
  lspBinaryCandidates: VsCodeLspBinaryCandidate[]
  warnings: string[]
}

/**
 * Static permission inference result. See
 * `lib/plugin/vscode-shim/permission-inference.ts`.
 *
 * `confidence` reflects how reliable the static analysis is — `"high"` for
 * un-minified source, `"medium"` for source with mangled identifiers,
 * `"low"` for minified bundles where the runtime gate is the primary check.
 */
export interface VsCodePermissionInference {
  permissions: PluginPermission[]
  reasons: VsCodePermissionReason[]
  confidence: "high" | "medium" | "low"
  // True if static analysis couldn't parse the bundle (e.g. wasm, native).
  unparsedBundle: boolean
  /**
   * `vscode.*` namespaces the bundle references that the shim mounts but does
   * not implement (every method throws `NotSupportedError`). See
   * `lib/plugin/vscode-shim/engine-compat.ts`.
   *
   * **UX signal only.** The walk fails open on minified bundles, so an empty
   * list means "no evidence found", never "uses nothing unsupported" — read it
   * together with `confidence` / `unparsedBundle`. It must never be wired into
   * a permission or security decision.
   */
  unsupportedApis: string[]
}

export interface VsCodePermissionReason {
  permission: PluginPermission
  trigger:
    | { kind: "require"; module: string }
    | { kind: "import"; module: string }
    | { kind: "manifest-contribution"; contribution: string }
    | { kind: "vscode-api"; api: string }
    | { kind: "fetch-call" }
    | { kind: "binary-file"; path: string }
  evidence: string
}

/**
 * An executable artefact discovered in the `.vsix` payload. The LSP binary
 * policy decides whether it may be spawned at runtime.
 */
export interface VsCodeLspBinaryCandidate {
  path: string
  size: number
  sha256: string
  kind: "native-exe" | "shell-script" | "node-binary" | "wasm-component" | "unknown"
}

// =============================================================================
// VS Code extension manifest block (cognia side)
// =============================================================================

/**
 * Field block embedded in a cognia `PluginManifest` when `type === "vscode-extension"`.
 * Stores the originating VS Code metadata so the host can re-derive contribution
 * details without re-parsing the `.vsix`.
 */
export interface VsCodeExtensionBlock {
  /** Canonical VS Code identifier (`publisher.name`). */
  identifier: string
  /** Original `version` from the VS Code manifest. */
  version: string
  /** Original `engines.vscode` constraint, preserved for telemetry. */
  engineVscode: string
  /** SHA-256 of the source `.vsix` file. */
  vsixSha256: string
  /**
   * Ed25519 public key fingerprint of the publisher, when discovered via
   * `trustedPublishers` ledger. Absent means "unverified publisher".
   */
  publisherKeyFingerprint?: string
  /** Marketplace source. `null` for `.vsix` drag-drop installs. */
  source: "openvsx" | "vsix-upload" | "dev" | null
  /**
   * The Open VSX `targetPlatform` this build was resolved for (one of the 12
   * enum values in `lib/plugin/vscode-shim/openvsx-platform.ts`, typically the
   * host platform or `"universal"`).
   *
   * Recorded so the update check can re-query the platform the user actually
   * installed rather than the platform of whatever machine is asking. Those
   * differ whenever a `universal` fallback was installed, and re-querying by
   * host would silently offer a platform-specific build as an "update".
   *
   * Absent for `.vsix` uploads — a local file carries no registry platform.
   * Typed `string` rather than the enum because `types/` must not depend on
   * `lib/`; the union is enforced where the value is produced.
   */
  targetPlatform?: string
  /**
   * `vscode.*` namespaces the bundle references that cognia's shim does not
   * implement, captured at install time so the warning survives onto the
   * extension card instead of vanishing with the install dialog.
   *
   * Best-effort and fails open — see `VsCodePermissionInference.unsupportedApis`.
   * Advisory copy only; never a gate.
   */
  unsupportedApis?: string[]
  /** Bundle module format detected at install time. */
  bundleFormat: "cjs" | "esm" | "mixed"
  /** Activation events declared in the VS Code manifest, preserved verbatim. */
  activationEvents: VsCodeActivationEvent[]
}
