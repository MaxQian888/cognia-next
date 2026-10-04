import { parseMarkdownAgent, serializeMarkdownAgent } from "@/lib/claude/agents/markdown-agents"
import { MCP_AGENT_ADAPTERS } from "@/lib/claude/agents"
import { serializeSkill } from "@/lib/claude/skills-io"
import { HOOK_EVENTS } from "@/lib/claude/hooks/event-catalog"
import { DORMANT_HOOK_HANDLER_FIELDS, type HookGroup, type HooksConfig } from "@/lib/claude/hooks"
import type { PluginManifest } from "@/types/plugin/plugin"
import type { PluginMcpServerPresetDef } from "@/types/plugin/plugin-mcp-preset"
import type { PluginSkillDef } from "@/types/plugin/plugin-skill"
import type { PluginSubagentDef } from "@/types/plugin/plugin-subagent"
import type { McpServer } from "@cognia/agent-config-types"
import { parse as parseToml } from "smol-toml"
import { slugify } from "./identity"
import { assembleManifest, serializeManifest, type RuntimeNeed } from "./manifest"
import { describeConfig, readMcpDrafts } from "./mcp-source"
import { parseExistingManifest } from "./merge"
import { renderDist } from "./scaffold"
import { buildSkill } from "./skill-source"
import { sanitizeMcpConfig } from "./secrets"
import { assessPluginDelivery } from "./delivery"
import { isOverlayEntryAllowed, isPluginEnvironmentFile } from "./source-snapshot"
import {
  checkSkillSemantics,
  normalizePlatformBundle,
  projectPlatformBundle,
  PLATFORM_BUNDLE_PROFILES,
  type PlatformBundleProjection,
  type PlatformBundleTarget,
} from "./platform-bundles"
import {
  CLAUDE_FAMILY_PROFILES,
  claudeFamilyManifestPath,
  projectClaudeFamilyBundle,
  replaceRootTokens,
  type ClaudeFamilyEcosystem,
  type ClaudeFamilyProfile,
} from "./claude-family"
import {
  HOOK_DIALECTS,
  canonicalHooksToDialect,
  hookDocumentToCanonical,
  type HookDialect,
} from "./hook-dialects"
import { detectPluginBundle, VENDOR_MANIFEST_PATHS } from "./bundle-detection"
import { classifySkillsForPiPackage, planPiExport, planPiImport } from "./pi-package"
import type { PluginPiPackageDef } from "@/types/plugin/plugin-pi-package"
import matter from "gray-matter"

export type PluginEcosystem = import("./delivery").PluginDeliveryTarget
export type PluginConversionFidelity = "native-exact" | "structured" | "contextual" | "unsupported"

export interface PluginConversionIssue {
  capability: string
  path: string
  message: string
  blocking: boolean
}

export interface PluginConversionReport {
  delivery?: import("./delivery").PluginDeliveryAssessment
  fidelity: PluginConversionFidelity
  converted: PluginConversionIssue[]
  warnings: PluginConversionIssue[]
  blocking: PluginConversionIssue[]
}

export interface PluginConversionOptions {
  hostVersion?: string
  /** Paths represented in `files` by placeholders and copied byte-for-byte by the CLI. */
  binaryPaths?: ReadonlySet<string>
}

export interface PluginConversionResult {
  source: PluginEcosystem
  target: PluginEcosystem
  manifest: PluginManifest
  files: Map<string, string>
  copies: Array<{ from: string; to: string }>
  report: PluginConversionReport
}

export class UnsupportedPluginConversionError extends Error {
  readonly report: PluginConversionReport

  constructor(source: PluginEcosystem, target: PluginEcosystem, report: PluginConversionReport) {
    const details = report.blocking.map((issue) => `${issue.path}: ${issue.message}`).join("; ")
    super(`cannot convert ${source} plugin to ${target} without losing behavior: ${details}`)
    this.name = "UnsupportedPluginConversionError"
    this.report = report
  }
}

type SourceFiles = ReadonlyMap<string, string>

interface ForeignPluginMetadata {
  id: string
  name: string
  version: string
  description: string
  author: { name: string; email?: string; url?: string }
  license: string
  homepage?: string
  repository?: string
  keywords?: string[]
  icon?: string
  screenshots?: string[]
}

interface CanonicalContributions {
  skills: PluginSkillDef[]
  subagents: PluginSubagentDef[]
  presets: PluginMcpServerPresetDef[]
  /** Converted `hooks.json` / manifest `hooks` blocks → `manifest.commandHooks`. */
  commandHooks?: HooksConfig
  /** Complete Pi packages retained in the plugin directory. */
  piPackages?: PluginPiPackageDef[]
  needsFilesystem: boolean
}

function normalizePath(path: string): string {
  const parts: string[] = []
  for (const part of path.replaceAll("\\", "/").split("/")) {
    if (!part || part === ".") continue
    if (part === "..") {
      if (parts.length === 0) throw new Error(`path escapes plugin root: ${path}`)
      parts.pop()
      continue
    }
    parts.push(part)
  }
  return parts.join("/")
}

function parseJsonObject(text: string, path: string): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch (error) {
    throw new Error(
      `could not parse ${path}: ${error instanceof Error ? error.message : String(error)}`
    )
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${path} must contain a JSON object`)
  }
  return value as Record<string, unknown>
}

function requiredString(value: unknown, path: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${path} must be a non-empty string`)
  }
  return value.trim()
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const result = value.filter((item): item is string => typeof item === "string")
  return result.length > 0 ? result : undefined
}

function configured(value: unknown): boolean {
  if (value === undefined || value === null || value === false) return false
  if (typeof value === "string") return value.trim().length > 0
  if (Array.isArray(value)) return value.length > 0
  if (typeof value === "object") return Object.keys(value).length > 0
  return true
}

function pathList(value: unknown, defaultPath?: string): string[] {
  const raw =
    typeof value === "string"
      ? [value]
      : Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string")
        : defaultPath
          ? [defaultPath]
          : []
  return raw.map(normalizePath)
}

function filesBelow(files: SourceFiles, directory: string): string[] {
  const prefix = `${normalizePath(directory)}/`
  return Array.from(files.keys())
    .map(normalizePath)
    .filter((path) => path.startsWith(prefix))
    .map((path) => path.slice(prefix.length))
}

function displayNameFromPath(path: string): string {
  const basename = normalizePath(path).split("/").pop() ?? path
  return basename.replace(/\.(md|json)$/i, "")
}

function authorFields(
  author: unknown,
  fallbackName = "unknown"
): { name: string; email?: string; url?: string } {
  if (typeof author === "string" && author.trim()) return { name: author.trim() }
  if (author && typeof author === "object" && !Array.isArray(author)) {
    const record = author as Record<string, unknown>
    const name = optionalString(record.name) ?? fallbackName
    const email = optionalString(record.email)
    const url = optionalString(record.url)
    return {
      name,
      ...(email ? { email } : {}),
      ...(url ? { url } : {}),
    }
  }
  return { name: fallbackName }
}

/** Plugin-root bindings a source host expands, canonicalized to `${COGNIA_PLUGIN_ROOT}`. */
interface RootTokenSet {
  tokens: readonly string[]
  envVars: readonly string[]
}

/** Codex, Gemini and normalized platform bundles: the historical token set. */
const DEFAULT_ROOT_TOKENS: RootTokenSet = {
  tokens: ["${CLAUDE_PLUGIN_ROOT}", "${CODEX_PLUGIN_ROOT}", "${PLUGIN_ROOT}", "${extensionPath}"],
  envVars: [],
}

function replacePluginRootToken(
  value: unknown,
  roots: RootTokenSet = DEFAULT_ROOT_TOKENS
): unknown {
  return replaceRootTokens(value, roots.tokens, roots.envVars, "${COGNIA_PLUGIN_ROOT}")
}

const UNSUPPORTED_RUNTIME_TOKENS = [
  "${PLUGIN_DATA}",
  "${CLAUDE_PLUGIN_DATA}",
  "${COPILOT_PLUGIN_DATA}",
  "${QODER_PLUGIN_DATA}",
  "${CODEBUDDY_PLUGIN_DATA}",
  "${CLAUDE_PROJECT_DIR}",
  "${workspacePath}",
  "${user_config.",
] as const

function rejectUnsupportedRuntimeTokens(args: {
  text: string
  capability: string
  path: string
  report: PluginConversionReport
}): boolean {
  const found = UNSUPPORTED_RUNTIME_TOKENS.filter((token) => args.text.includes(token)).map(
    (token) => (token.endsWith(".") ? `${token}KEY}` : token)
  )
  if (found.length === 0) return false
  args.report.blocking.push({
    capability: args.capability,
    path: args.path,
    message: `runtime variables have no equivalent Cognia binding: ${found.join(", ")}`,
    blocking: true,
  })
  return true
}

function unsupportedIssue(capability: string, target = "cognia"): PluginConversionIssue {
  return {
    capability,
    path: capability,
    message: `${capability} requires a ${target} adapter or host runtime; native conversion is not implemented`,
    blocking: true,
  }
}

function reportUnknownManifestFields(args: {
  manifest: Record<string, unknown>
  known: ReadonlySet<string>
  sourcePath: string
  report: PluginConversionReport
}): void {
  for (const field of Object.keys(args.manifest).sort()) {
    if (args.known.has(field)) continue
    args.report.blocking.push({
      capability: field,
      path: `${args.sourcePath}.${field}`,
      message: "unknown manifest field may carry behavior and cannot be converted safely",
      blocking: true,
    })
  }
}

function reportUnmappedPresentationFields(
  value: Record<string, unknown> | undefined,
  mapped: ReadonlySet<string>,
  report: PluginConversionReport
): void {
  if (!value) return
  for (const [field, fieldValue] of Object.entries(value)) {
    if (!configured(fieldValue) || mapped.has(field)) continue
    report.warnings.push({
      capability: "interface",
      path: `interface.${field}`,
      message: "presentation metadata has no Cognia manifest equivalent and was not projected",
      blocking: false,
    })
  }
}

function cloneFiles(files: SourceFiles): Map<string, string> {
  return new Map(Array.from(files, ([path, contents]) => [normalizePath(path), contents] as const))
}

function metadataFromForeignManifest(
  manifest: Record<string, unknown>,
  sourcePath: string,
  interfaceMetadata?: Record<string, unknown>
): ForeignPluginMetadata {
  const rawName = requiredString(manifest.name, `${sourcePath}.name`)
  const id = slugify(rawName)
  if (!id) throw new Error(`${sourcePath}.name cannot produce a valid plugin id`)
  return {
    id,
    name:
      optionalString(manifest.displayName) ??
      optionalString(interfaceMetadata?.displayName) ??
      rawName,
    version: optionalString(manifest.version) ?? "0.1.0",
    description:
      optionalString(manifest.description) ??
      optionalString(interfaceMetadata?.shortDescription) ??
      "",
    author: authorFields(manifest.author),
    license: optionalString(manifest.license) ?? "MIT",
    homepage:
      optionalString(manifest.homepage) ??
      optionalString(interfaceMetadata?.websiteUrl) ??
      optionalString(interfaceMetadata?.websiteURL),
    repository: optionalString(manifest.repository),
    keywords: stringArray(manifest.keywords),
    icon:
      optionalString(interfaceMetadata?.logo) ??
      optionalString(interfaceMetadata?.composerIcon) ??
      optionalString(manifest.icon) ??
      optionalString(manifest.logo),
    screenshots: stringArray(interfaceMetadata?.screenshots),
  }
}

function finalizeForeignConversion(args: {
  source: Exclude<PluginEcosystem, "cognia">
  output: Map<string, string>
  metadata: ForeignPluginMetadata
  contributions: CanonicalContributions
  report: PluginConversionReport
  options: PluginConversionOptions
  /** Keep source manifests byte-for-byte (a retained Pi package is read by Pi itself). */
  retainSourceManifests?: boolean
}): PluginConversionResult {
  const { source, output, metadata, contributions, report, options } = args
  if (report.blocking.length > 0) {
    report.fidelity = "unsupported"
    throw new UnsupportedPluginConversionError(source, "cognia", report)
  }

  const capabilities: PluginManifest["capabilities"] = []
  if (contributions.skills.length > 0) capabilities.push("skills")
  if (contributions.subagents.length > 0) capabilities.push("subagent")
  if (contributions.presets.length > 0) capabilities.push("mcp-server-preset")
  const hasCommandHooks = Object.values(contributions.commandHooks ?? {}).some(
    (groups) => Array.isArray(groups) && groups.length > 0
  )
  if (hasCommandHooks) capabilities.push("command-hooks")
  const piPackages = contributions.piPackages ?? []
  if (piPackages.length > 0) capabilities.push("pi-package")

  const need: RuntimeNeed =
    hasCommandHooks ||
    piPackages.length > 0 ||
    contributions.presets.some((preset) => preset.transport === "stdio")
      ? "host-process"
      : contributions.needsFilesystem
        ? "host-filesystem"
        : "portable"
  const manifest = assembleManifest({
    identity: {
      id: metadata.id,
      name: metadata.name,
      version: metadata.version,
      description: metadata.description,
      author: metadata.author.name,
      authorEmail: metadata.author.email,
      license: metadata.license,
      minAppVersion: options.hostVersion ?? "0.1.0",
    },
    capabilities,
    need,
    contributions: {
      ...(contributions.skills.length > 0 ? { skills: contributions.skills } : {}),
      ...(contributions.subagents.length > 0 ? { subagents: contributions.subagents } : {}),
      ...(contributions.presets.length > 0 ? { mcpServerPresets: contributions.presets } : {}),
      ...(hasCommandHooks ? { commandHooks: contributions.commandHooks } : {}),
      ...(piPackages.length > 0 ? { piPackages } : {}),
    },
  })
  manifest.homepage = metadata.homepage
  manifest.repository = metadata.repository
  manifest.keywords = metadata.keywords
  manifest.icon = metadata.icon
  manifest.screenshots = metadata.screenshots
  if (metadata.author.url && manifest.author) {
    manifest.author.url = metadata.author.url
  }
  // Imported source manifests/configuration may contain credentials. The canonical
  // manifest replaces their role. Overwrite, rather than delete, because installers
  // apply generated-file overlays on top of the original source snapshot.
  if (!args.retainSourceManifests)
    for (const path of VENDOR_MANIFEST_PATHS) if (output.has(path)) output.set(path, "{}\n")
  for (const path of output.keys()) {
    if (isPluginEnvironmentFile(path)) output.set(path, "\n")
  }
  output.set("plugin.json", serializeManifest(manifest))
  output.set("dist/index.js", renderDist(manifest))

  return {
    source,
    target: "cognia",
    manifest,
    files: output,
    copies: [...(options.binaryPaths ?? [])]
      .filter((path) => output.has(path) && !isPluginEnvironmentFile(path))
      .map((path) => ({ from: path, to: path })),
    report,
  }
}

type DeclaredPathMode = "additive" | "replace" | "ambiguous"

function skillFilesBelow(files: SourceFiles, root: string): string[] {
  if (files.has(`${root}/SKILL.md`)) return [`${root}/SKILL.md`]
  return Array.from(files.keys())
    .map(normalizePath)
    .filter((path) => path.startsWith(`${root}/`) && path.endsWith("/SKILL.md"))
}

/**
 * Skill files a manifest selects. `additive` hosts (Claude Code) read declared
 * paths on top of `skills/`; `replace` hosts read only the declared paths;
 * `ambiguous` hosts do not document which, so a declaration that would change
 * the answer is reported instead of guessed.
 */
function collectSkillMarkdownFiles(
  files: SourceFiles,
  declared: unknown,
  mode: DeclaredPathMode = "replace",
  report?: PluginConversionReport
): string[] {
  const declaredPaths = pathList(declared)
  const roots =
    declaredPaths.length === 0
      ? ["skills"]
      : mode === "additive"
        ? ["skills", ...declaredPaths]
        : declaredPaths
  const result = new Set<string>()
  for (const root of roots) {
    if (/\.md$/i.test(root)) {
      if (files.has(root)) result.add(root)
      continue
    }
    // `"."` normalizes to the plugin root: the root SKILL.md is the skill.
    if (root === "") {
      if (files.has("SKILL.md")) result.add("SKILL.md")
      continue
    }
    for (const path of skillFilesBelow(files, root)) result.add(path)
  }
  if (mode === "ambiguous" && declaredPaths.length > 0 && report) {
    const conventional = skillFilesBelow(files, "skills").filter((path) => !result.has(path))
    if (conventional.length)
      report.blocking.push({
        capability: "skills",
        path: "skills",
        message:
          "The manifest declares skill paths while skills/ holds other skills; this host does not document whether declared paths add to or replace skills/",
        blocking: true,
      })
  }
  return Array.from(result).sort()
}

/** Root skills share a plugin directory; package controls are not skill resources. */
function rootSkillFiles(files: SourceFiles, runtimeEntry?: string): string[] {
  return [...files.keys()].filter(
    (path) =>
      path !== runtimeEntry &&
      !isPluginEnvironmentFile(path) &&
      !/^(?:\.(?:claude|codex|cursor|devin|factory|qoder|codebuddy|workbuddy|augment|goose)-plugin\/|\.plugin\/|\.cognia-normalized\/|\.github\/|\.opencode\/|(?:skills|agents|droids|commands|hooks|policies|rules|output-styles|workflows)\/|(?:plugin|gemini-extension|mcp|\.mcp|hooks|settings|opencode)\.jsonc?$)/.test(
        path
      )
  )
}

function convertSkillFiles(args: {
  files: SourceFiles
  declared: unknown
  output: Map<string, string>
  report: PluginConversionReport
  mode?: DeclaredPathMode
  /** Exact skill files already resolved by the host's own discovery rules (Pi). */
  explicit?: string[]
  /** Fall back to a root SKILL.md when nothing is declared (legacy hosts). */
  rootFallback?: boolean
  /** Resources of a root SKILL.md when the host treats the whole directory as the skill. */
  rootResources?: string[]
}): { skills: PluginSkillDef[]; needsFilesystem: boolean } {
  const { files, declared, report } = args
  const paths = args.explicit
    ? [...args.explicit]
    : collectSkillMarkdownFiles(files, declared, args.mode, report)
  if (
    !args.explicit &&
    args.rootFallback !== false &&
    !configured(declared) &&
    files.has("SKILL.md") &&
    !paths.includes("SKILL.md")
  )
    paths.unshift("SKILL.md")
  const skills: PluginSkillDef[] = []
  let needsFilesystem = false
  if (configured(declared) && paths.length === 0) {
    report.blocking.push({
      capability: "skills",
      path: "skills",
      message: "declared skill paths did not contain a SKILL.md file",
      blocking: true,
    })
  }
  for (const skillFile of paths) {
    const text = files.get(skillFile)
    if (text === undefined) continue
    rejectUnsupportedRuntimeTokens({
      text,
      capability: "skills",
      path: skillFile,
      report,
    })
    // A Markdown file not named SKILL.md is a standalone skill (Pi flat skills):
    // its directory is shared, so it owns no resources.
    const standalone = !/(^|\/)SKILL\.md$/.test(skillFile)
    const directory = standalone ? "" : skillFile.slice(0, Math.max(0, skillFile.lastIndexOf("/")))
    const resources = standalone
      ? []
      : directory
        ? filesBelow(files, directory)
        : (args.rootResources ?? rootSkillFiles(files))
    const built = buildSkill(text, resources, displayNameFromPath(directory || skillFile))
    for (const message of built.blockers)
      report.blocking.push({ capability: "skills", path: skillFile, message, blocking: true })
    if (built.skill.source.kind === "local-bundle") {
      built.skill.source = { kind: "local-bundle", path: directory || "." }
    }
    skills.push(built.skill)
    needsFilesystem ||= built.needsFilesystem
    for (const warning of built.warnings) {
      report.warnings.push({
        capability: "skills",
        path: skillFile,
        message: warning,
        blocking: false,
      })
    }
    report.converted.push({
      capability: "skills",
      path: skillFile,
      message: `converted skill ${built.skill.id}`,
      blocking: false,
    })
  }
  return { skills, needsFilesystem }
}

function mcpDocuments(
  files: SourceFiles,
  declared: unknown,
  defaultPath: string,
  rootKey = "mcpServers",
  mode: "merge" | "replace" | "ambiguous" = "replace",
  report?: PluginConversionReport
): Array<{ path: string; value: Record<string, unknown> }> {
  const documents: Array<{ path: string; value: Record<string, unknown> }> = []
  const declaredItems = Array.isArray(declared)
    ? declared
    : declared === undefined
      ? []
      : [declared]
  for (const item of declaredItems) {
    if (item && typeof item === "object" && !Array.isArray(item)) {
      const record = item as Record<string, unknown>
      documents.push({ path: rootKey, value: rootKey in record ? record : { [rootKey]: record } })
    } else if (typeof item === "string" && item.trim()) {
      if (/^https?:\/\//i.test(item) || /\.(?:mcpb|dxt)$/i.test(item)) {
        report?.blocking.push({
          capability: "mcpServers",
          path: item,
          message:
            "Packaged (.mcpb/.dxt) or remote MCP declarations are installed by the host; no Cognia preset can be derived without fetching them",
          blocking: true,
        })
        continue
      }
      const path = normalizePath(item)
      const text = files.get(path)
      if (text === undefined) throw new Error(`declared MCP configuration was not found: ${path}`)
      documents.push({ path, value: parseJsonObject(text, path) })
    } else if (item !== undefined) {
      throw new Error("mcpServers must be a path, an inline server map, or an array of these")
    }
  }
  const conventional = files.has(defaultPath) && !documents.some((doc) => doc.path === defaultPath)
  if (conventional && (documents.length === 0 || mode === "merge"))
    documents.push({
      path: defaultPath,
      value: parseJsonObject(files.get(defaultPath)!, defaultPath),
    })
  else if (conventional && mode === "ambiguous")
    report?.blocking.push({
      capability: "mcpServers",
      path: defaultPath,
      message: `The manifest declares MCP servers while ${defaultPath} also exists; this host does not document whether they merge`,
      blocking: true,
    })
  return documents
}

function convertMcpDocuments(args: {
  documents: Array<{ path: string; value: Record<string, unknown> }>
  adapterSourceName: string
  output: Map<string, string>
  report: PluginConversionReport
  roots?: RootTokenSet
}): PluginMcpServerPresetDef[] {
  const presets: PluginMcpServerPresetDef[] = []
  for (const document of args.documents) {
    rejectUnsupportedRuntimeTokens({
      text: JSON.stringify(document.value),
      capability: "mcpServers",
      path: document.path,
      report: args.report,
    })
    const canonicalText = JSON.stringify(replacePluginRootToken(document.value, args.roots))
    const declaredServers = document.value.mcpServers
    let drafts: ReturnType<typeof readMcpDrafts>["drafts"]
    try {
      drafts = readMcpDrafts(canonicalText, args.adapterSourceName).drafts
    } catch {
      args.report.blocking.push({
        capability: "mcpServers",
        path: document.path,
        message: "MCP configuration does not contain valid server declarations",
        blocking: true,
      })
      continue
    }
    if (declaredServers && typeof declaredServers === "object" && !Array.isArray(declaredServers)) {
      for (const name of Object.keys(declaredServers)) {
        if (!drafts.some((draft) => draft.name === name))
          args.report.blocking.push({
            capability: "mcpServers",
            path: `${document.path}.${name}`,
            message: "Declared MCP server could not be parsed; conversion cannot silently omit it",
            blocking: true,
          })
      }
    }
    // Overwrite original configuration in generated-file overlays: deleting a map
    // entry would leave the original source file intact in local/GitHub installs.
    if (args.output.has(document.path)) args.output.set(document.path, "{}\n")
    for (const path of VENDOR_MANIFEST_PATHS)
      if (args.output.has(path)) args.output.set(path, "{}\n")
    for (const path of args.output.keys())
      if (isPluginEnvironmentFile(path)) args.output.set(path, "\n")
    for (const draft of drafts) {
      const hostFields = [
        "excludeTools",
        "includeTools",
        "disabled",
        "enabled",
        "trust",
        "autoApprove",
      ].filter((field) => draft.config[field] !== undefined)
      if (hostFields.length)
        args.report.blocking.push({
          capability: "mcpServers",
          path: `${document.path}.${draft.name}`,
          message: `Host-specific MCP policy requires an enforcement adapter: ${hostFields.join(", ")}`,
          blocking: true,
        })
      const sanitized = sanitizeMcpConfig(draft.transport, draft.config)
      // Plugin-relative environment bindings are portable executable references,
      // not user credentials. Retain them without asking the user for a path.
      const env = draft.config.env as Record<string, unknown> | undefined
      for (const [key, value] of Object.entries(env ?? {})) {
        if (typeof value === "string" && value.startsWith("${COGNIA_PLUGIN_ROOT}")) {
          ;(sanitized.config.env as Record<string, unknown>)[key] = value
          sanitized.fields = sanitized.fields.filter(
            (field) => !(field.placement === "env" && field.key === key)
          )
        }
      }
      const preset: PluginMcpServerPresetDef = {
        id: draft.name,
        name: draft.name,
        description: describeConfig(draft.transport, sanitized.config),
        transport: draft.transport,
        config: sanitized.config,
        fields: sanitized.fields,
      }
      for (const field of sanitized.fields.filter(
        (field) => field.secret || field.placement === "url"
      )) {
        const original =
          field.placement === "env"
            ? (draft.config.env as Record<string, unknown>)?.[field.key]
            : field.placement === "header"
              ? (draft.config.headers as Record<string, unknown>)?.[field.key]
              : draft.config.url
        if (typeof original !== "string" || !original || /^\$\{[A-Z0-9_]+\}$/.test(original))
          continue
        for (const [path, contents] of args.output) {
          if (contents.includes(original))
            args.report.blocking.push({
              capability: "secrets",
              path,
              message:
                "A credential removed from MCP configuration is also present in this bundled file; remove it before conversion",
              blocking: true,
            })
        }
      }
      presets.push(preset)
      if (sanitized.fields.length)
        args.report.warnings.push({
          capability: "mcpServers",
          path: document.path,
          message: `User configuration required for ${draft.name}: ${sanitized.fields.map((field) => field.key).join(", ")}; source values were removed`,
          blocking: false,
        })
      args.report.converted.push({
        capability: "mcpServers",
        path: document.path,
        message: `converted MCP server ${preset.id}`,
        blocking: false,
      })
    }
  }
  return presets
}

/**
 * Hook handler types the Cognia runners can execute verbatim. `plugin` is
 * excluded on purpose: it names an in-process hook of the SOURCE plugin's own
 * runtime code, which a converted declarative bundle cannot carry — treating
 * it as a shell command would silently produce a hook that always fails.
 */
const CONVERTIBLE_HOOK_HANDLER_TYPES = new Set([
  "command",
  "http",
  "webhook",
  "prompt",
  "agent",
  "mcp_tool",
])

/**
 * Gather the hook documents a foreign plugin declares: the manifest `hooks`
 * field (a file path or an inline event map) plus the conventional
 * `hooks/hooks.json` / `hooks.json` files. Deduplicates by path so a manifest
 * pointing at its own conventional file doesn't convert it twice.
 */
function collectHookDocuments(args: {
  files: SourceFiles
  declared: unknown
  sourcePath: string
  report: PluginConversionReport
  defaultDiscovery?: boolean
  /** Conventional hook files, in host read order. */
  defaultFiles?: readonly string[]
  /** Declared hooks add to (`merge`) or replace the conventional files. */
  mode?: "merge" | "replace" | "ambiguous"
}): Array<{ path: string; value: Record<string, unknown> }> {
  const { files, declared, sourcePath, report } = args
  const documents: Array<{ path: string; value: Record<string, unknown> }> = []
  const seen = new Set<string>()
  const addFile = (path: string) => {
    const normalized = normalizePath(path)
    if (seen.has(normalized)) return
    const text = files.get(normalized)
    if (text === undefined) return
    seen.add(normalized)
    documents.push({ path: normalized, value: parseJsonObject(text, normalized) })
  }
  const addDeclared = (value: unknown, path: string) => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => addDeclared(item, `${path}[${index}]`))
      return
    }
    if (typeof value === "string" && value.trim()) {
      const normalized = normalizePath(value)
      if (!files.has(normalized))
        report.blocking.push({
          capability: "commandHooks",
          path: normalized,
          message: "declared hooks file was not found",
          blocking: true,
        })
      else addFile(normalized)
    } else if (value && typeof value === "object") {
      documents.push({ path, value: value as Record<string, unknown> })
    } else if (value !== undefined) {
      report.blocking.push({
        capability: "commandHooks",
        path,
        message: "manifest hooks field must be a file path, inline event map, or array of these",
        blocking: true,
      })
    }
  }
  addDeclared(declared, `${sourcePath}.hooks`)
  const declaredCount = documents.length
  const defaults = (args.defaultFiles ?? ["hooks/hooks.json", "hooks.json"]).filter(
    (path) => files.has(path) && !seen.has(path)
  )
  const mode = args.mode ?? "merge"
  if (args.defaultDiscovery !== false) {
    if (declaredCount === 0 || mode === "merge") for (const path of defaults) addFile(path)
    else if (mode === "ambiguous" && defaults.length)
      report.blocking.push({
        capability: "commandHooks",
        path: defaults[0],
        message:
          "The manifest declares hooks while the conventional hook file also exists; this host does not document whether they merge",
        blocking: true,
      })
  }
  return documents
}

/**
 * Convert hook documents into a `commandHooks` contribution. The event map
 * shape (`Event → [{matcher?, hooks: [handlers]}]`) is already Cognia's
 * canonical `HooksConfig`, so groups pass through once validated:
 *
 * - events must be {@link HOOK_EVENTS} members — anything else (notably
 *   `PostMarketplace`, whose install-time lifecycle has no Cognia equivalent)
 *   is a blocking issue rather than a silent drop;
 * - each group must be an object carrying a `hooks` array;
 * - each handler must be an object whose `type` is a runnable handler kind —
 *   `plugin` handlers reference source-runtime code and are blocking.
 *
 * Plugin-root tokens are canonicalized to `${COGNIA_PLUGIN_ROOT}`; the host
 * binds the token to the install dir when it merges the block.
 */
function convertHookDocuments(args: {
  documents: Array<{ path: string; value: Record<string, unknown> }>
  report: PluginConversionReport
  roots?: RootTokenSet
  /** Source host dialect; non-Claude documents are translated before validation. */
  dialect?: HookDialect
}): HooksConfig {
  const { report } = args
  const documents = args.dialect
    ? args.documents.map((document) => ({
        path: document.path,
        value: hookDocumentToCanonical({
          value: document.value,
          path: document.path,
          dialect: args.dialect!,
          sink: report,
        }),
      }))
    : args.documents
  const merged: Record<string, HookGroup[]> = {}
  let convertedGroups = 0
  for (const document of documents) {
    const text = JSON.stringify(document.value)
    rejectUnsupportedRuntimeTokens({
      text,
      capability: "commandHooks",
      path: document.path,
      report,
    })
    const canonical = replacePluginRootToken(document.value, args.roots) as Record<string, unknown>
    // `hooks/hooks.json` wraps the map in a `hooks` key; a manifest's inline
    // `hooks` field IS the map. Accept the wrapper when present.
    const inner = canonical.hooks
    const eventMap =
      inner && typeof inner === "object" && !Array.isArray(inner)
        ? (inner as Record<string, unknown>)
        : canonical
    for (const [event, groups] of Object.entries(eventMap)) {
      if (!(HOOK_EVENTS as readonly string[]).includes(event)) {
        report.blocking.push({
          capability: "commandHooks",
          path: document.path,
          message:
            `hook event "${event}" has no Cognia hook-runtime equivalent ` +
            "(install/update lifecycle events are not dispatched to command hooks)",
          blocking: true,
        })
        continue
      }
      if (!Array.isArray(groups)) {
        report.blocking.push({
          capability: "commandHooks",
          path: document.path,
          message: `hook event "${event}" must map to an array of groups`,
          blocking: true,
        })
        continue
      }
      let usable = true
      for (const [index, group] of groups.entries()) {
        if (!group || typeof group !== "object" || Array.isArray(group)) {
          report.blocking.push({
            capability: "commandHooks",
            path: document.path,
            message: `hook group "${event}"[${index}] must be an object`,
            blocking: true,
          })
          usable = false
          continue
        }
        const unknownGroupKeys = Object.keys(group).filter(
          (key) => !["matcher", "hooks"].includes(key)
        )
        if (unknownGroupKeys.length) {
          report.blocking.push({
            capability: "commandHooks",
            path: document.path,
            message: `Unsupported hook group selectors/fields: ${unknownGroupKeys.join(", ")}`,
            blocking: true,
          })
          usable = false
        }
        const handlers = (group as Record<string, unknown>).hooks
        if (!Array.isArray(handlers)) {
          report.blocking.push({
            capability: "commandHooks",
            path: document.path,
            message: `hook group "${event}"[${index}] must carry a "hooks" handler array`,
            blocking: true,
          })
          usable = false
          continue
        }
        for (const [handlerIndex, handler] of handlers.entries()) {
          const type =
            handler && typeof handler === "object" && !Array.isArray(handler)
              ? (handler as Record<string, unknown>).type
              : undefined
          if (handler && typeof handler === "object" && !Array.isArray(handler)) {
            const record = handler as Record<string, unknown>
            const supported = new Set([
              "type",
              "timeout",
              ...(type === "command"
                ? ["command", "async"]
                : type === "http" || type === "webhook"
                  ? ["url", "headers"]
                  : type === "prompt" || type === "agent"
                    ? ["prompt", "model"]
                    : type === "mcp_tool"
                      ? ["server", "tool", "input"]
                      : []),
            ])
            const unknown = Object.keys(record).filter(
              (key) => !supported.has(key) && !DORMANT_HOOK_HANDLER_FIELDS.includes(key)
            )
            if (unknown.length) {
              report.blocking.push({
                capability: "commandHooks",
                path: document.path,
                message: `Unsupported hook handler fields: ${unknown.join(", ")}`,
                blocking: true,
              })
              usable = false
            }
            if (
              (record.timeout !== undefined &&
                (typeof record.timeout !== "number" ||
                  !Number.isFinite(record.timeout) ||
                  record.timeout <= 0)) ||
              (record.async !== undefined && typeof record.async !== "boolean")
            ) {
              report.blocking.push({
                capability: "commandHooks",
                path: document.path,
                message: "Hook timeout must be a positive number and async must be boolean",
                blocking: true,
              })
              usable = false
            }
            const dormant = DORMANT_HOOK_HANDLER_FIELDS.filter((field) => configured(record[field]))
            if (dormant.length) {
              report.blocking.push({
                capability: "commandHooks",
                path: document.path,
                message: `Cognia runners do not execute hook fields: ${dormant.join(", ")}`,
                blocking: true,
              })
              usable = false
            }
            const required =
              type === "command"
                ? "command"
                : type === "http" || type === "webhook"
                  ? "url"
                  : type === "prompt" || type === "agent"
                    ? "prompt"
                    : undefined
            if (
              type === "mcp_tool" &&
              (!optionalString(record.server) || !optionalString(record.tool))
            ) {
              report.blocking.push({
                capability: "commandHooks",
                path: document.path,
                message: "MCP hook handler requires non-empty server and tool identifiers",
                blocking: true,
              })
              usable = false
            }
            if (required && !optionalString(record[required])) {
              report.blocking.push({
                capability: "commandHooks",
                path: document.path,
                message: `hook handler requires a non-empty ${required}`,
                blocking: true,
              })
              usable = false
            }
          }
          if (typeof type !== "string" || !CONVERTIBLE_HOOK_HANDLER_TYPES.has(type)) {
            report.blocking.push({
              capability: "commandHooks",
              path: document.path,
              message:
                `hook handler "${event}"[${index}].hooks[${handlerIndex}] has ` +
                `unsupported type ${JSON.stringify(type ?? null)} — only ` +
                `${[...CONVERTIBLE_HOOK_HANDLER_TYPES].join("/")} handlers convert`,
              blocking: true,
            })
            usable = false
          }
        }
      }
      if (!usable) continue
      const target = (merged[event] ??= [])
      for (const group of groups) {
        target.push(group as HookGroup)
        convertedGroups += 1
      }
    }
    if (convertedGroups > 0) {
      report.converted.push({
        capability: "commandHooks",
        path: document.path,
        message: `converted ${convertedGroups} hook group(s) into manifest.commandHooks`,
        blocking: false,
      })
      convertedGroups = 0
    }
  }
  return merged as HooksConfig
}

export function detectPluginEcosystem(files: SourceFiles): PluginEcosystem {
  return detectPluginBundle(files).ecosystem
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

/**
 * Convert one Markdown agent definition. `allowedFields === null` keeps the
 * Claude parser's own field handling; otherwise every frontmatter key must be
 * listed (values in `defaults` only restate Cognia's default and are dropped).
 */
function convertMarkdownAgent(args: {
  path: string
  text: string
  id: string
  label: string
  allowedFields: readonly string[] | null
  defaults?: Readonly<Record<string, unknown>>
  /** Host spellings of a Cognia field (`max_turns` → `maxTurns`). */
  renames?: Readonly<Record<string, string>>
  report: PluginConversionReport
}): PluginSubagentDef | null {
  const { path, report } = args
  let text = args.text
  if (args.allowedFields) {
    let parsed: matter.GrayMatterFile<string>
    try {
      parsed = matter(text)
    } catch (error) {
      report.blocking.push({
        capability: "agents",
        path,
        message: `frontmatter parse failed: ${error instanceof Error ? error.message : String(error)}`,
        blocking: true,
      })
      return null
    }
    const data: Record<string, unknown> = { ...parsed.data }
    for (const [from, to] of Object.entries(args.renames ?? {})) {
      if (data[from] === undefined) continue
      data[to] = data[from]
      delete data[from]
    }
    for (const [key, value] of Object.entries(args.defaults ?? {}))
      if (data[key] === value) delete data[key]
    const unsupported = Object.keys(data).filter((key) => !args.allowedFields!.includes(key))
    if (unsupported.length) {
      report.blocking.push({
        capability: "agents",
        path,
        message: `${args.label} agent fields have no exact Cognia equivalent: ${unsupported.join(", ")}`,
        blocking: true,
      })
      return null
    }
    if (typeof data.name === "string" && slugify(data.name) !== slugify(args.id))
      report.warnings.push({
        capability: "agents",
        path,
        message: `${args.label} display name "${data.name}" is not projected; the agent id is "${slugify(args.id)}"`,
        blocking: false,
      })
    delete data.name
    text = matter.stringify(parsed.content, data)
  }
  rejectUnsupportedRuntimeTokens({ text, capability: "agents", path, report })
  const parsed = parseMarkdownAgent(slugify(args.id), text)
  if ("error" in parsed) {
    report.blocking.push({ capability: "agents", path, message: parsed.error, blocking: true })
    return null
  }
  if (parsed.unsupportedFields.length > 0) {
    report.blocking.push({
      capability: "agents",
      path,
      message: `unsupported subagent fields: ${parsed.unsupportedFields.join(", ")}`,
      blocking: true,
    })
    return null
  }
  report.converted.push({
    capability: "agents",
    path,
    message: `converted subagent ${parsed.id}`,
    blocking: false,
  })
  return { id: parsed.id, name: parsed.id, ...parsed.def }
}

/** Claude command object form: `{ name: { source | content, description, … } }`. */
function convertCommandMap(args: {
  commands: Record<string, unknown>
  files: SourceFiles
  report: PluginConversionReport
}): PluginSkillDef[] {
  const skills: PluginSkillDef[] = []
  for (const [name, raw] of Object.entries(args.commands)) {
    const path = `commands.${name}`
    if (!isRecord(raw)) {
      args.report.blocking.push({
        capability: "commands",
        path,
        message: "command entries must be objects with source or content",
        blocking: true,
      })
      continue
    }
    const unknown = Object.keys(raw).filter(
      (key) => !["source", "content", "description", "argumentHint", "allowedTools"].includes(key)
    )
    if (unknown.length) {
      args.report.blocking.push({
        capability: "commands",
        path,
        message: `command fields have no exact Cognia equivalent: ${unknown.join(", ")}`,
        blocking: true,
      })
      continue
    }
    let body: string | undefined
    if (typeof raw.content === "string") body = raw.content
    else if (typeof raw.source === "string") {
      const sourcePath = normalizePath(raw.source)
      body = args.files.get(sourcePath)
      if (body === undefined) {
        args.report.blocking.push({
          capability: "commands",
          path,
          message: `command source was not found: ${sourcePath}`,
          blocking: true,
        })
        continue
      }
    } else {
      args.report.blocking.push({
        capability: "commands",
        path,
        message: "command entries require source or content",
        blocking: true,
      })
      continue
    }
    if (raw.argumentHint !== undefined)
      args.report.warnings.push({
        capability: "commands",
        path,
        message: "argumentHint only labels the command in the host UI and was not projected",
        blocking: false,
      })
    const parsed = matter(body)
    const data: Record<string, unknown> = { ...parsed.data, name }
    if (typeof raw.description === "string") data.description = raw.description
    if (Array.isArray(raw.allowedTools)) data["allowed-tools"] = raw.allowedTools
    rejectUnsupportedRuntimeTokens({
      text: body,
      capability: "commands",
      path,
      report: args.report,
    })
    const built = buildSkill(matter.stringify(parsed.content, data), [], name)
    for (const message of built.blockers)
      args.report.blocking.push({ capability: "commands", path, message, blocking: true })
    skills.push(built.skill)
    args.report.converted.push({
      capability: "commands",
      path,
      message: `converted prompt command to skill ${built.skill.id}`,
      blocking: false,
    })
  }
  return skills
}

/**
 * Import a Claude-family plugin (Claude Code itself, or a vendor layout that
 * adopted it) through its profile. Normalized platform bundles reuse this with
 * the Claude Code profile and their own declared-path semantics.
 */
function convertClaudePlugin(
  files: SourceFiles,
  options: PluginConversionOptions,
  profile: ClaudeFamilyProfile = CLAUDE_FAMILY_PROFILES["claude-code"],
  overrides: {
    skillsMode?: DeclaredPathMode
    mcpMode?: "merge" | "replace" | "ambiguous"
    /** Skill files a platform adapter already resolved with its host's rules. */
    explicitSkills?: string[]
    /** Read the profile's conventional hook files when nothing is declared. */
    hookDefaults?: boolean
    /** Install-time settings referenced by MCP servers (Cursor variables). */
    settings?: PlatformBundleProjection["settings"]
    rootSkillResources?: string[]
  } = {}
): PluginConversionResult {
  const sourcePath = claudeFamilyManifestPath(files, profile) ?? profile.manifestPaths[0]
  const source = parseJsonObject(requiredString(files.get(sourcePath), sourcePath), sourcePath)
  const roots: RootTokenSet = { tokens: profile.rootTokens, envVars: profile.rootEnvVars }
  const honored = new Set(profile.componentFields)
  const report: PluginConversionReport = {
    fidelity: "structured",
    converted: [],
    warnings: [],
    blocking: [],
  }
  const fail = (capability: string, path: string, message: string) =>
    report.blocking.push({ capability, path, message, blocking: true })
  const warn = (capability: string, path: string, message: string) =>
    report.warnings.push({ capability, path, message, blocking: false })

  for (const field of Object.keys(source).sort()) {
    const value = source[field]
    if (profile.metadataFields.includes(field) || honored.has(field)) continue
    if (Object.hasOwn(profile.ignoredFields, field)) {
      if (configured(value)) warn(field, `${sourcePath}.${field}`, profile.ignoredFields[field])
      continue
    }
    if (Object.hasOwn(profile.blockedFields, field)) {
      if (configured(value)) fail(field, field, profile.blockedFields[field])
      continue
    }
    if (profile.unknownFields === "warn")
      warn(
        field,
        `${sourcePath}.${field}`,
        `${profile.label} ignores unknown manifest keys; this field carries no behavior there and was not projected`
      )
    else
      fail(
        field,
        `${sourcePath}.${field}`,
        "unknown manifest field may carry behavior and cannot be converted safely"
      )
  }
  if (typeof source.name === "string" && !profile.nameRule.pattern.test(source.name))
    warn(
      "name",
      `${sourcePath}.name`,
      `${profile.nameRule.message}; the host may refuse this plugin`
    )
  if (profile.requireDotSlashPaths) {
    for (const field of honored) {
      const value = source[field]
      const paths =
        typeof value === "string"
          ? [value]
          : Array.isArray(value)
            ? value.filter((v) => typeof v === "string")
            : []
      for (const path of paths as string[])
        if (!path.startsWith("./") && !(field === "skills" && path === "."))
          warn(
            field,
            `${sourcePath}.${field}`,
            `${profile.label} requires component paths to start with ./ (got ${JSON.stringify(path)}); the host may refuse this manifest`
          )
    }
  }
  for (const entry of profile.blockedPaths) {
    const present = Array.from(files.keys()).some((path) =>
      entry.path.endsWith("/")
        ? normalizePath(path).startsWith(entry.path)
        : normalizePath(path) === entry.path
    )
    if (!present) continue
    if ("warn" in entry && entry.warn) warn(entry.capability, entry.path, entry.message)
    else if (!report.blocking.some((issue) => issue.capability === entry.capability))
      fail(entry.capability, entry.path, entry.message)
  }

  // Hooks convert rather than block. Run this before the early throw so
  // unmappable hook surfaces surface alongside the other blockers in one report.
  const commandHooks = convertHookDocuments({
    documents: collectHookDocuments({
      files,
      declared: honored.has("hooks") ? source.hooks : undefined,
      sourcePath,
      report,
      defaultFiles: profile.hookFiles,
      mode: profile.hooksMode,
      defaultDiscovery: overrides.hookDefaults !== false,
    }),
    report,
    roots,
    dialect: profile.hookDialect.id === "claude-code" ? undefined : profile.hookDialect,
  })
  if (report.blocking.length > 0) {
    report.fidelity = "unsupported"
    throw new UnsupportedPluginConversionError(profile.ecosystem, "cognia", report)
  }

  const output = cloneFiles(files)
  const convertedSkills = convertSkillFiles({
    files,
    declared: honored.has("skills") ? source.skills : undefined,
    output,
    report,
    mode: overrides.skillsMode ?? profile.skillsMode,
    explicit: overrides.explicitSkills,
    rootResources: overrides.rootSkillResources,
  })
  const skills = convertedSkills.skills

  if (profile.commandsDir) {
    const declaredCommands = honored.has("commands") ? source.commands : undefined
    if (isRecord(declaredCommands)) {
      if (profile.ecosystem === "claude-code")
        skills.push(...convertCommandMap({ commands: declaredCommands, files, report }))
      else
        fail(
          "commands",
          `${sourcePath}.commands`,
          `${profile.label} does not document inline command maps`
        )
    } else {
      const commandConversionStart = report.converted.length
      for (const path of pathList(declaredCommands, profile.commandsDir)) {
        const below = path.toLowerCase().endsWith(".md")
          ? [path]
          : Array.from(files.keys()).filter((file) => normalizePath(file).startsWith(`${path}/`))
        for (const commandPath of below) {
          if (!/\.md$/i.test(commandPath)) {
            if (profile.ecosystem === "factory-droid")
              fail(
                "commands",
                commandPath,
                "Droid executable command files run host code; Cognia has no executable slash-command contribution"
              )
            continue
          }
          const text = files.get(commandPath)
          if (text === undefined) continue
          rejectUnsupportedRuntimeTokens({
            text,
            capability: "commands",
            path: commandPath,
            report,
          })
          const built = buildSkill(text, [], displayNameFromPath(commandPath))
          for (const message of built.blockers)
            report.blocking.push({
              capability: "commands",
              path: commandPath,
              message,
              blocking: true,
            })
          skills.push(built.skill)
          report.converted.push({
            capability: "commands",
            path: commandPath,
            message: `converted prompt command to skill ${built.skill.id}`,
            blocking: false,
          })
        }
      }
      if (configured(declaredCommands) && report.converted.length === commandConversionStart)
        fail(
          "commands",
          "commands",
          "declared command paths did not contain Markdown command files"
        )
    }
  }

  const subagents: PluginSubagentDef[] = []
  const agentConversionStart = report.converted.length
  const declaredAgents = honored.has("agents") ? source.agents : undefined
  for (const path of pathList(declaredAgents, profile.agentsDir)) {
    const candidates = path.toLowerCase().endsWith(".md")
      ? [path]
      : Array.from(files.keys()).filter(
          (file) => normalizePath(file).startsWith(`${path}/`) && /\.md$/i.test(file)
        )
    for (const agentPath of candidates) {
      const text = files.get(agentPath)
      if (text === undefined) continue
      const id = profile.agentId(normalizePath(agentPath).split("/").pop() ?? agentPath)
      if (!id) continue
      const agent = convertMarkdownAgent({
        path: agentPath,
        text,
        id,
        label: profile.label,
        allowedFields: profile.agentFields,
        defaults: profile.agentDefaults,
        report,
      })
      if (agent) subagents.push(agent)
    }
  }
  if (configured(declaredAgents) && report.converted.length === agentConversionStart)
    fail("agents", "agents", "declared agent paths did not contain valid Markdown agents")

  const presets = convertMcpDocuments({
    documents: mcpDocuments(
      files,
      honored.has("mcpServers") ? source.mcpServers : undefined,
      profile.mcpFile,
      "mcpServers",
      overrides.mcpMode ?? profile.mcpMode,
      report
    ),
    adapterSourceName: "claude-code.json",
    output,
    report,
    roots,
  })
  if (overrides.settings)
    importInstallSettings({
      declarations: overrides.settings.declarations,
      presets,
      servers: overrides.settings.servers as Record<string, Record<string, unknown>>,
      report,
      capability: "variables",
      exposeToStdio: false,
    })
  return finalizeForeignConversion({
    source: profile.ecosystem,
    output,
    metadata: metadataFromForeignManifest(source, sourcePath),
    contributions: {
      skills,
      subagents,
      presets,
      commandHooks,
      needsFilesystem: convertedSkills.needsFilesystem,
    },
    report,
    options,
  })
}

function convertCodexPlugin(
  files: SourceFiles,
  options: PluginConversionOptions
): PluginConversionResult {
  const sourcePath = ".codex-plugin/plugin.json"
  const source = parseJsonObject(requiredString(files.get(sourcePath), sourcePath), sourcePath)
  const blocking = [
    ["apps", source.apps],
    ["extensions", source.extensions],
  ]
    .filter(([, value]) => configured(value))
    .map(([capability]) => unsupportedIssue(String(capability)))
  // `.app.json` is discovered by convention: ChatGPT app connectors need OpenAI's host.
  if (files.has(".app.json") && !configured(source.apps)) blocking.push(unsupportedIssue("apps"))
  const report: PluginConversionReport = {
    fidelity: blocking.length > 0 ? "unsupported" : "structured",
    converted: [],
    warnings: [],
    blocking,
  }
  reportUnknownManifestFields({
    manifest: source,
    known: new Set([
      "name",
      "version",
      "description",
      "author",
      "homepage",
      "repository",
      "license",
      "keywords",
      "skills",
      "hooks",
      "mcpServers",
      "apps",
      "interface",
      "extensions",
      "commands",
    ]),
    sourcePath,
    report,
  })
  // Codex hooks use the Claude event-map shape with Codex's own event and
  // handler subset (see HOOK_DIALECTS.codex). Declared hooks replace defaults.
  const commandHooks = convertHookDocuments({
    documents: collectHookDocuments({
      files,
      declared: source.hooks,
      sourcePath,
      report,
      defaultDiscovery: source.hooks === undefined,
      defaultFiles: ["hooks/hooks.json"],
    }),
    report,
    roots: {
      tokens: ["${PLUGIN_ROOT}", "${CLAUDE_PLUGIN_ROOT}", "${CODEX_PLUGIN_ROOT}"],
      envVars: ["PLUGIN_ROOT", "CLAUDE_PLUGIN_ROOT"],
    },
    dialect: HOOK_DIALECTS.codex,
  })
  const output = cloneFiles(files)
  const convertedSkills = convertSkillFiles({
    files,
    declared: source.skills,
    output,
    report,
  })
  // Codex migrates declared Markdown commands into skills at install time.
  const commandSkills: PluginSkillDef[] = []
  for (const path of pathList(source.commands)) {
    const candidates = /\.md$/i.test(path)
      ? [path]
      : Array.from(files.keys()).filter(
          (file) => normalizePath(file).startsWith(`${path}/`) && /\.md$/i.test(file)
        )
    if (candidates.length === 0)
      report.blocking.push({
        capability: "commands",
        path,
        message: "declared command paths did not contain Markdown command files",
        blocking: true,
      })
    for (const commandPath of candidates) {
      const text = files.get(commandPath)
      if (text === undefined) continue
      rejectUnsupportedRuntimeTokens({ text, capability: "commands", path: commandPath, report })
      const built = buildSkill(text, [], displayNameFromPath(commandPath))
      for (const message of built.blockers)
        report.blocking.push({ capability: "commands", path: commandPath, message, blocking: true })
      commandSkills.push(built.skill)
      report.converted.push({
        capability: "commands",
        path: commandPath,
        message: `converted command to skill ${built.skill.id} (Codex migrates commands to skills)`,
        blocking: false,
      })
    }
  }
  const presets = convertMcpDocuments({
    documents: mcpDocuments(files, source.mcpServers, ".mcp.json"),
    adapterSourceName: "claude-code.json",
    output,
    report,
  })
  const interfaceMetadata =
    source.interface && typeof source.interface === "object" && !Array.isArray(source.interface)
      ? (source.interface as Record<string, unknown>)
      : undefined
  const mappedInterfaceFields = new Set(["displayName", "shortDescription", "screenshots"])
  if (
    interfaceMetadata &&
    !optionalString(source.description) &&
    optionalString(interfaceMetadata.longDescription)
  ) {
    source.description = interfaceMetadata.longDescription
    mappedInterfaceFields.add("longDescription")
  }
  if (
    interfaceMetadata &&
    !configured(source.author) &&
    optionalString(interfaceMetadata.developerName)
  ) {
    source.author = { name: interfaceMetadata.developerName }
    mappedInterfaceFields.add("developerName")
  }
  for (const key of ["websiteUrl", "websiteURL"])
    if (
      interfaceMetadata &&
      !optionalString(source.homepage) &&
      optionalString(interfaceMetadata[key])
    )
      mappedInterfaceFields.add(key)
  if (interfaceMetadata) {
    if (optionalString(interfaceMetadata.logo)) {
      mappedInterfaceFields.add("logo")
    } else if (optionalString(interfaceMetadata.composerIcon)) {
      mappedInterfaceFields.add("composerIcon")
    }
  }
  reportUnmappedPresentationFields(interfaceMetadata, mappedInterfaceFields, report)
  return finalizeForeignConversion({
    source: "codex",
    output,
    metadata: metadataFromForeignManifest(source, sourcePath, interfaceMetadata),
    contributions: {
      skills: [...convertedSkills.skills, ...commandSkills],
      subagents: [],
      presets,
      commandHooks,
      needsFilesystem: convertedSkills.needsFilesystem,
    },
    report,
    options,
  })
}

function parseGeminiCommand(
  path: string,
  text: string,
  report: PluginConversionReport
): PluginSkillDef | null {
  let parsed: unknown
  try {
    parsed = parseToml(text)
  } catch (error) {
    report.blocking.push({
      capability: "commands",
      path,
      message: `invalid TOML: ${error instanceof Error ? error.message : String(error)}`,
      blocking: true,
    })
    return null
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    report.blocking.push({
      capability: "commands",
      path,
      message: "command TOML must contain an object",
      blocking: true,
    })
    return null
  }
  const command = parsed as Record<string, unknown>
  const prompt = optionalString(command.prompt)
  if (!prompt) {
    report.blocking.push({
      capability: "commands",
      path,
      message: "command is missing the required prompt string",
      blocking: true,
    })
    return null
  }
  if (/!\{[\s\S]*\}/.test(prompt)) {
    report.blocking.push({
      capability: "commands",
      path,
      message: "shell interpolation cannot be executed by a declarative Cognia skill",
      blocking: true,
    })
    return null
  }
  const relative = normalizePath(path)
    .replace(/^commands\//, "")
    .replace(/\.toml$/i, "")
  const id = slugify(relative.replaceAll("/", "-"))
  report.warnings.push({
    capability: "commands",
    path,
    message:
      "converted to a contextual skill; Gemini command argument and file interpolation markers remain literal",
    blocking: false,
  })
  report.converted.push({
    capability: "commands",
    path,
    message: `converted prompt command to skill ${id}`,
    blocking: false,
  })
  return {
    id,
    name: relative.replaceAll("/", ":"),
    description: optionalString(command.description) ?? "",
    source: { kind: "inline", markdown: prompt },
  }
}

function convertGeminiPlugin(
  files: SourceFiles,
  options: PluginConversionOptions
): PluginConversionResult {
  const sourcePath = "gemini-extension.json"
  const source = parseJsonObject(requiredString(files.get(sourcePath), sourcePath), sourcePath)
  const blocking = [
    ["excludeTools", source.excludeTools],
    ["themes", source.themes],
    ["plan", source.plan],
  ]
    .filter(([, value]) => configured(value))
    .map(([capability]) => unsupportedIssue(String(capability)))
  const report: PluginConversionReport = {
    fidelity: blocking.length > 0 ? "unsupported" : "structured",
    converted: [],
    warnings: [],
    blocking,
  }
  reportUnknownManifestFields({
    manifest: source,
    known: new Set([
      "name",
      "version",
      "description",
      "author",
      "homepage",
      "repository",
      "license",
      "keywords",
      "contextFileName",
      "excludeTools",
      "mcpServers",
      "settings",
      "themes",
      "plan",
      "migratedTo",
    ]),
    sourcePath,
    report,
  })
  if (configured(source.migratedTo))
    report.warnings.push({
      capability: "migratedTo",
      path: `${sourcePath}.migratedTo`,
      message: "Gemini update redirection is an install-time concern and was not projected",
      blocking: false,
    })
  if (typeof source.name === "string" && !/^[a-zA-Z0-9-]+$/.test(source.name))
    report.warnings.push({
      capability: "name",
      path: `${sourcePath}.name`,
      message:
        "Gemini extension names must match ^[a-zA-Z0-9-]+$; the host may refuse this extension",
      blocking: false,
    })
  // `${/}` (alias `${pathSeparator}`) is the OS path separator; "/" is valid on every Cognia desktop OS.
  const separatorFiles = new Map(files)
  for (const path of [sourcePath, "hooks/hooks.json"]) {
    const text = files.get(path)
    if (text === undefined || !/\$\{(?:\/|pathSeparator)\}/.test(text)) continue
    separatorFiles.set(path, text.replaceAll("${/}", "/").replaceAll("${pathSeparator}", "/"))
    report.warnings.push({
      capability: "variables",
      path,
      message: "Gemini ${/} path separators were normalized to /",
      blocking: false,
    })
  }
  const geminiSource =
    separatorFiles.get(sourcePath) === files.get(sourcePath)
      ? source
      : parseJsonObject(separatorFiles.get(sourcePath)!, sourcePath)
  const output = cloneFiles(files)
  const convertedSkills = convertSkillFiles({ files, declared: undefined, output, report })
  const skills: PluginSkillDef[] = [...convertedSkills.skills]
  if (filesBelow(files, "policies").length)
    report.blocking.push({
      capability: "policies",
      path: "policies/",
      message: "Gemini policy engine rules (policies/*.toml) have no Cognia equivalent",
      blocking: true,
    })
  const commandHooks = convertHookDocuments({
    documents: collectHookDocuments({
      files: separatorFiles,
      declared: undefined,
      sourcePath,
      report,
      defaultFiles: ["hooks/hooks.json"],
    }),
    report,
    roots: { tokens: ["${extensionPath}"], envVars: [] },
    dialect: HOOK_DIALECTS["gemini-cli"],
  })
  const subagents: PluginSubagentDef[] = []
  for (const agentPath of Array.from(files.keys()).map(normalizePath).sort()) {
    if (!/^agents\/[^/]+\.md$/i.test(agentPath)) continue
    const agent = convertMarkdownAgent({
      path: agentPath,
      text: files.get(agentPath)!,
      id: displayNameFromPath(agentPath),
      label: "Gemini CLI",
      allowedFields: ["name", "description", "maxTurns"],
      defaults: { kind: "local" },
      renames: { max_turns: "maxTurns" },
      report,
    })
    if (agent) {
      subagents.push(agent)
      report.warnings.push({
        capability: "agents",
        path: agentPath,
        message: "Gemini extension agents are a preview feature; routing parity must be verified",
        blocking: false,
      })
    }
  }
  const contextPaths =
    typeof source.contextFileName === "string"
      ? [source.contextFileName]
      : Array.isArray(source.contextFileName)
        ? source.contextFileName.filter((entry): entry is string => typeof entry === "string")
        : ["GEMINI.md"]
  for (const [index, contextPath] of contextPaths.entries()) {
    const context = files.get(normalizePath(contextPath))
    if (context !== undefined && context.trim()) {
      rejectUnsupportedRuntimeTokens({
        text: context,
        capability: "context",
        path: contextPath,
        report,
      })
      skills.push({
        id: index === 0 ? "gemini-context" : `gemini-context-${index + 1}`,
        name: index === 0 ? "Gemini Context" : `Gemini Context ${index + 1}`,
        description: "Extension context imported from Gemini CLI.",
        source: { kind: "inline", markdown: context.trim() },
      })
      report.converted.push({
        capability: "context",
        path: contextPath,
        message: "converted extension context to a skill",
        blocking: false,
      })
    } else if (source.contextFileName !== undefined) {
      report.blocking.push({
        capability: "context",
        path: contextPath,
        message: "declared context file was not found or was empty",
        blocking: true,
      })
    }
  }

  for (const path of Array.from(files.keys()).map(normalizePath).sort()) {
    if (!path.startsWith("commands/") || !path.endsWith(".toml")) continue
    const skill = parseGeminiCommand(path, requiredString(files.get(path), path), report)
    if (skill) skills.push(skill)
  }
  if (report.warnings.some((issue) => issue.capability === "commands")) {
    report.fidelity = "contextual"
  }

  // Gemini reads MCP servers from the manifest only; a stray .mcp.json is not loaded.
  const presets = convertMcpDocuments({
    documents: mcpDocuments(files, geminiSource.mcpServers, ""),
    adapterSourceName: "gemini.json",
    output,
    report,
    roots: { tokens: ["${extensionPath}"], envVars: [] },
  })
  importGeminiSettings({ settings: source.settings, presets, source: geminiSource, report })
  return finalizeForeignConversion({
    source: "gemini-cli",
    output,
    metadata: metadataFromForeignManifest(source, sourcePath),
    contributions: {
      skills,
      subagents,
      presets,
      commandHooks,
      needsFilesystem: convertedSkills.needsFilesystem,
    },
    report,
    options,
  })
}

/** Gemini install settings are environment bindings, not arbitrary manifest keys.
 * Preserve their placement and secret marker in Cognia's existing preset fields. */
function importGeminiSettings(args: {
  settings: unknown
  presets: PluginMcpServerPresetDef[]
  source: Record<string, unknown>
  report: PluginConversionReport
}): void {
  if (args.settings === undefined) return
  const fail = (path: string, message: string) =>
    args.report.blocking.push({ capability: "settings", path, message, blocking: true })
  if (!Array.isArray(args.settings)) {
    fail("settings", "Gemini settings must be an array")
    return
  }
  const declarations: Array<InstallSetting & { path: string }> = []
  const seen = new Set<string>()
  for (const [index, value] of args.settings.entries()) {
    const path = `settings[${index}]`
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      fail(path, "Gemini setting must be an object")
      continue
    }
    const setting = value as Record<string, unknown>
    const variable = optionalString(setting.envVar)
    const label = optionalString(setting.name)
    if (
      !variable ||
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(variable) ||
      !label ||
      seen.has(variable) ||
      Object.keys(setting).some(
        (key) => !["name", "description", "envVar", "sensitive"].includes(key)
      ) ||
      (setting.sensitive !== undefined && typeof setting.sensitive !== "boolean")
    ) {
      fail(
        path,
        "Setting has invalid/duplicate environment variable, missing name, or unsupported configuration fields"
      )
      continue
    }
    seen.add(variable)
    declarations.push({
      path,
      envVar: variable,
      name: label,
      description: optionalString(setting.description),
      sensitive: Boolean(setting.sensitive),
    })
  }
  importInstallSettings({
    declarations,
    presets: args.presets,
    servers: (args.source.mcpServers ?? {}) as Record<string, Record<string, unknown>>,
    report: args.report,
    capability: "settings",
    // Gemini also exposes declared settings directly to local server processes.
    exposeToStdio: true,
  })
}

interface InstallSetting {
  envVar: string
  name: string
  description?: string
  sensitive: boolean
}

/**
 * Bind install-time settings (Gemini `settings`, Cursor `variables`) to the
 * preset fields of the servers that reference them as `${NAME}`. A setting
 * composed into a larger value has no field placement and is blocking.
 */
function importInstallSettings(args: {
  declarations: Array<InstallSetting & { path?: string }>
  presets: PluginMcpServerPresetDef[]
  servers: Record<string, Record<string, unknown>>
  report: PluginConversionReport
  capability: string
  exposeToStdio: boolean
}): void {
  const fail = (path: string, message: string) =>
    args.report.blocking.push({ capability: args.capability, path, message, blocking: true })
  for (const setting of args.declarations) {
    const path = setting.path ?? `${args.capability}.${setting.envVar}`
    const variable = setting.envVar
    const label = setting.name
    const reference = "${" + variable + "}"
    let used = false
    for (const preset of args.presets) {
      const original = args.servers[preset.id] ?? {}
      const fields = (preset.fields ??= [])
      const add = (field: NonNullable<PluginMcpServerPresetDef["fields"]>[number]) => {
        const existing = fields.findIndex(
          (candidate) => candidate.placement === field.placement && candidate.key === field.key
        )
        const mapped = {
          ...field,
          label,
          ...(setting.description ? { description: setting.description } : {}),
          secret: setting.sensitive,
        }
        if (existing >= 0) fields[existing] = mapped
        else fields.push(mapped)
        used = true
      }
      const env = original.env as Record<string, unknown> | undefined
      for (const [key, raw] of Object.entries(env ?? {})) {
        if (raw === reference) add({ key, label, placement: "env" })
        else if (typeof raw === "string" && raw.includes(reference))
          fail(
            path,
            `Composed environment binding ${key} cannot be represented by a Cognia preset field`
          )
      }
      const headers = original.headers as Record<string, unknown> | undefined
      for (const [key, raw] of Object.entries(headers ?? {})) {
        if (raw === reference) add({ key, label, placement: "header" })
        else if (typeof raw === "string" && raw.includes(reference))
          fail(
            path,
            `Composed header binding ${key} cannot be represented by a Cognia preset field`
          )
      }
      const url = original.httpUrl ?? original.url
      if (url === reference) add({ key: "url", label, placement: "url" })
      else if (typeof url === "string" && url.includes(reference))
        fail(
          path,
          "Composed URL bindings require a template adapter; conversion cannot replace them with an unrelated full URL"
        )
      if (
        Array.isArray(original.args) &&
        original.args.some((arg) => typeof arg === "string" && arg.includes(reference))
      )
        add({ key: variable, label, placement: "arg-replace", token: reference })
      if (args.exposeToStdio && preset.transport === "stdio" && !(variable in (env ?? {}))) {
        preset.config.env = {
          ...((preset.config.env as Record<string, unknown>) ?? {}),
          [variable]: "",
        }
        add({ key: variable, label, placement: "env" })
      }
    }
    if (!used)
      args.report.warnings.push({
        capability: args.capability,
        path,
        message:
          "Setting is not referenced by a converted MCP contribution; no Cognia field was created",
        blocking: false,
      })
  }
}

function loadCogniaPlugin(files: SourceFiles): PluginConversionResult {
  const manifest = parseExistingManifest(
    requiredString(files.get("plugin.json"), "plugin.json"),
    "plugin.json"
  )
  return {
    source: "cognia",
    target: "cognia",
    manifest,
    files: new Map(files),
    copies: [],
    report: {
      fidelity: "native-exact",
      converted: [],
      warnings: [],
      blocking: [],
    },
  }
}

function replaceCanonicalRootToken(value: unknown, target: PluginEcosystem): unknown {
  const token =
    target === "claude-code"
      ? "${CLAUDE_PLUGIN_ROOT}"
      : target === "gemini-cli"
        ? "${extensionPath}"
        : "${CLAUDE_PLUGIN_ROOT}"
  if (typeof value === "string") {
    return value.replaceAll("${COGNIA_PLUGIN_ROOT}", token)
  }
  if (Array.isArray(value)) return value.map((item) => replaceCanonicalRootToken(item, target))
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, replaceCanonicalRootToken(item, target)])
    )
  }
  return value
}

function exportCogniaSkills(args: {
  manifest: PluginManifest
  files: SourceFiles
  output: Map<string, string>
  target: Exclude<PluginEcosystem, "cognia">
  report: PluginConversionReport
  copies: Array<{ from: string; to: string }>
  binaryPaths?: ReadonlySet<string>
}): void {
  for (const skill of args.manifest.skills ?? []) {
    const targetDirectory = `skills/${skill.id}`
    if (
      args.target === "gemini-cli" &&
      (skill.invocationPolicy === "explicit" || skill.allowedTools?.length)
    ) {
      args.report.blocking.push({
        capability: "skills",
        path: `skills.${skill.id}`,
        message:
          "Gemini skill activation and tool approval do not implement Claude invocation/tool controls; export cannot silently loosen them",
        blocking: true,
      })
      continue
    }
    const markdown =
      skill.source.kind === "inline"
        ? skill.source.markdown
        : args.files.get(
            [normalizePath("path" in skill.source ? skill.source.path : ""), "SKILL.md"]
              .filter(Boolean)
              .join("/")
          )
    if (markdown) {
      const built = buildSkill(serializeSkill({ ...skill, content: markdown }), [], skill.name)
      for (const message of built.blockers)
        args.report.blocking.push({
          capability: "skills",
          path: `skills.${skill.id}`,
          message,
          blocking: true,
        })
    }
    if (skill.source.kind === "inline") {
      args.output.set(
        `${targetDirectory}/SKILL.md`,
        serializeSkill({
          ...skill,
          content: skill.source.markdown,
        })
      )
    } else if (skill.source.kind === "local-folder" || skill.source.kind === "local-bundle") {
      const sourceDirectory = normalizePath(skill.source.path)
      const sourcePrefix = sourceDirectory ? `${sourceDirectory}/` : ""
      const originalMarkdown = args.files.get(`${sourcePrefix}SKILL.md`)
      if (originalMarkdown === undefined) {
        args.report.blocking.push({
          capability: "skills",
          path: sourceDirectory,
          message: `skill bundle ${skill.id} was not found or is missing SKILL.md`,
          blocking: true,
        })
        continue
      }
      const parsedBundle = buildSkill(originalMarkdown, [], skill.name)
      for (const message of parsedBundle.blockers)
        args.report.blocking.push({
          capability: "skills",
          path: `${sourceDirectory}/SKILL.md`,
          message,
          blocking: true,
        })
      if (
        args.target === "gemini-cli" &&
        (parsedBundle.skill.invocationPolicy === "explicit" ||
          parsedBundle.skill.allowedTools?.length)
      )
        args.report.blocking.push({
          capability: "skills",
          path: `${sourceDirectory}/SKILL.md`,
          message: "Gemini cannot enforce the skill's invocation or tool approval controls",
          blocking: true,
        })
      const rootFiles = sourceDirectory
        ? undefined
        : new Set(rootSkillFiles(args.files, args.manifest.main))
      const entries = Array.from(args.files.entries()).filter(
        ([path]) =>
          !isPluginEnvironmentFile(path) &&
          (rootFiles ? rootFiles.has(path) : normalizePath(path).startsWith(sourcePrefix))
      )
      if (entries.length === 0) {
        args.report.blocking.push({
          capability: "skills",
          path: skill.source.path,
          message: `skill bundle ${skill.id} was not found`,
          blocking: true,
        })
        continue
      }
      for (const [path, contents] of entries) {
        const relative = normalizePath(path).slice(sourcePrefix.length)
        const normalizedSource = normalizePath(path)
        const target = `${targetDirectory}/${relative}`
        if (args.binaryPaths?.has(normalizedSource)) {
          args.copies.push({ from: normalizedSource, to: target })
        } else {
          args.output.set(
            target,
            relative === "SKILL.md" && parsedBundle.skill.source.kind === "inline"
              ? serializeSkill({
                  ...parsedBundle.skill,
                  ...skill,
                  content: parsedBundle.skill.source.markdown,
                })
              : contents
          )
        }
      }
    } else {
      args.report.blocking.push({
        capability: "skills",
        path: `skills.${skill.id}.source`,
        message: `${skill.source.kind} skills cannot be represented as a self-contained ${args.target} bundle`,
        blocking: true,
      })
      continue
    }
    args.report.converted.push({
      capability: "skills",
      path: `skills.${skill.id}`,
      message: `exported skill ${skill.id}`,
      blocking: false,
    })
  }
}

function exportCogniaSubagents(args: {
  manifest: PluginManifest
  output: Map<string, string>
  target: Exclude<PluginEcosystem, "cognia">
  report: PluginConversionReport
}): void {
  const subagents = args.manifest.subagents ?? []
  if (subagents.length === 0) return
  if (args.target !== "claude-code" && args.target !== "gemini-cli") {
    args.report.blocking.push({
      capability: "subagent",
      path: "subagents",
      message: `${args.target} plugins have no subagent contribution; native export is not possible`,
      blocking: true,
    })
    return
  }
  if (args.target === "gemini-cli") {
    for (const agent of subagents) {
      const unsupported = Object.entries({
        provider: agent.provider,
        externalPresetId: agent.externalPresetId,
        mcpServerIds: agent.mcpServerIds?.length,
        allowNesting: agent.allowNesting,
        maxDepth: agent.maxDepth,
        hidden: agent.hidden,
        disabled: agent.disabled,
        tools: agent.tools?.length,
        disallowedTools: agent.disallowedTools?.length,
        model: agent.model,
        effort: agent.effort,
      })
        .filter(([, value]) => configured(value))
        .map(([key]) => key)
      if (unsupported.length) {
        args.report.blocking.push({
          capability: "subagent",
          path: `subagents.${agent.id}`,
          message: `Gemini extension agents have no exact equivalent for: ${unsupported.join(", ")}`,
          blocking: true,
        })
        continue
      }
      args.output.set(
        `agents/${agent.id}.md`,
        matter.stringify(agent.prompt.endsWith("\n") ? agent.prompt : `${agent.prompt}\n`, {
          name: agent.id,
          description: agent.description,
          ...(agent.maxTurns ? { max_turns: agent.maxTurns } : {}),
        })
      )
      args.report.converted.push({
        capability: "subagent",
        path: `subagents.${agent.id}`,
        message: `exported subagent ${agent.id}`,
        blocking: false,
      })
      args.report.warnings.push({
        capability: "subagent",
        path: `subagents.${agent.id}`,
        message: "Gemini extension agents are a preview feature; routing parity must be verified",
        blocking: false,
      })
    }
    return
  }
  for (const agent of subagents) {
    const unsupported = [
      agent.provider,
      agent.externalPresetId,
      agent.mcpServerIds?.length,
      agent.allowNesting,
      agent.maxDepth,
      agent.hidden,
      agent.disabled,
    ].some(configured)
    if (unsupported) {
      args.report.blocking.push({
        capability: "subagent",
        path: `subagents.${agent.id}`,
        message: "subagent contains Cognia-only routing, nesting, or visibility controls",
        blocking: true,
      })
      continue
    }
    args.output.set(
      `agents/${agent.id}.md`,
      serializeMarkdownAgent(agent.id, {
        description: agent.description,
        prompt: agent.prompt,
        tools: agent.tools,
        disallowedTools: agent.disallowedTools,
        model: agent.model,
        maxTurns: agent.maxTurns,
        effort: agent.effort,
      })
    )
    args.report.converted.push({
      capability: "subagent",
      path: `subagents.${agent.id}`,
      message: `exported subagent ${agent.id}`,
      blocking: false,
    })
  }
}

function exportMcpServers(args: {
  manifest: PluginManifest
  output: Map<string, string>
  target: Exclude<PluginEcosystem, "cognia">
  report: PluginConversionReport
  settings: Array<Record<string, unknown>>
  removedValues: Set<string>
  /** Install-time fields project to Gemini settings or Cursor variables. */
  fieldProjection?: "gemini-settings" | "cursor-variables"
}): Record<string, unknown> | undefined {
  const fieldProjection =
    args.fieldProjection ?? (args.target === "gemini-cli" ? "gemini-settings" : undefined)
  const presets = args.manifest.mcpServerPresets ?? []
  if (presets.length === 0) return undefined
  const servers: McpServer[] = []
  for (const preset of presets) {
    const sanitized = sanitizeMcpConfig(preset.transport, preset.config)
    const config = sanitized.config
    const fields = [...(preset.fields ?? [])]
    for (const field of sanitized.fields) {
      const container = field.placement === "env" ? "env" : "headers"
      const original =
        field.placement === "url"
          ? preset.config.url
          : field.placement === "arg-replace"
            ? undefined
            : (preset.config[container] as Record<string, unknown> | undefined)?.[field.key]
      const binding =
        typeof original === "string" &&
        /^\$\{[A-Za-z_][A-Za-z0-9_]*\}(?:\/[^\r\n]*)?$/.test(original)
      if (field.placement === "arg-replace") {
        config.args = structuredClone(preset.config.args)
        continue
      }
      if ((field.placement === "env" && !field.secret) || binding) {
        if (field.placement === "url") config.url = original
        else
          config[container] = {
            ...((config[container] as Record<string, unknown>) ?? {}),
            [field.key]: original,
          }
        continue
      }
      if (typeof original === "string" && original) args.removedValues.add(original)
      if (
        !fields.some(
          (existing) => existing.key === field.key && existing.placement === field.placement
        )
      )
        fields.push(field)
    }
    const hostFields = [
      "excludeTools",
      "includeTools",
      "disabled",
      "enabled",
      "trust",
      "autoApprove",
    ].filter((field) => config[field] !== undefined)
    if (hostFields.length)
      args.report.blocking.push({
        capability: "mcp-server-preset",
        path: `mcpServerPresets.${preset.id}`,
        message: `Host-specific MCP policy requires a target enforcement adapter: ${hostFields.join(", ")}`,
        blocking: true,
      })
    if (
      preset.defaultDisallowedTools?.length ||
      preset.toolRiskRules?.length ||
      preset.provisioning?.mode === "managed" ||
      (preset.runtime && preset.runtime !== "both")
    ) {
      args.report.blocking.push({
        capability: "mcp-server-preset",
        path: `mcpServerPresets.${preset.id}`,
        message:
          "Cognia tool restrictions, runtime routing, managed provisioning, and risk policy require host enforcement; native export cannot drop them",
        blocking: true,
      })
      continue
    }
    if (fields.length && !fieldProjection) {
      args.report.blocking.push({
        capability: "mcp-server-preset",
        path: `mcpServerPresets.${preset.id}.fields`,
        message: `${args.target} installation configuration projection is not implemented; configure the preset or use Cognia hosting`,
        blocking: true,
      })
      continue
    }
    for (const field of fields) {
      const variable = `COGNIA_${preset.id}_${field.key}`.toUpperCase().replace(/[^A-Z0-9_]/g, "_")
      if (args.settings.some((setting) => setting.envVar === variable)) {
        args.report.blocking.push({
          capability: "mcp-server-preset",
          path: `mcpServerPresets.${preset.id}.fields`,
          message: "Configuration fields collide after environment-variable normalization",
          blocking: true,
        })
        continue
      }
      const reference = "${" + variable + "}"
      if (field.placement === "env" || field.placement === "header") {
        const key = field.placement === "env" ? "env" : "headers"
        config[key] = {
          ...((config[key] as Record<string, unknown>) ?? {}),
          [field.key]: reference,
        }
      } else if (field.placement === "url") {
        config.url = reference
      } else if (
        field.placement === "arg-replace" &&
        field.token &&
        Array.isArray(config.args) &&
        config.args.some((arg) => typeof arg === "string" && arg.includes(field.token!))
      ) {
        config.args = config.args.map((arg) =>
          typeof arg === "string" ? arg.replaceAll(field.token!, reference) : arg
        )
      } else {
        args.report.blocking.push({
          capability: "mcp-server-preset",
          path: `mcpServerPresets.${preset.id}.fields.${field.key}`,
          message: "Invalid configuration placement or missing argument replacement token",
          blocking: true,
        })
        continue
      }
      args.settings.push({
        name: field.label,
        description: field.description ?? field.label,
        envVar: variable,
        sensitive: Boolean(field.secret),
      })
    }
    if (fields.length)
      args.report.warnings.push({
        capability: "mcp-server-preset",
        path: `mcpServerPresets.${preset.id}.fields`,
        message:
          fieldProjection === "cursor-variables"
            ? "Cursor declares these as plugin variables; an administrator sets the values in the Cursor dashboard before use"
            : "Gemini requests these settings during installation; values must be supplied before use",
        blocking: false,
      })
    if (args.target === "codex" && preset.transport === "sse") {
      args.report.blocking.push({
        capability: "mcp-server-preset",
        path: `mcpServerPresets.${preset.id}.transport`,
        message: "Codex plugins do not support SSE MCP transport",
        blocking: true,
      })
      continue
    }
    servers.push({
      id: preset.id,
      name: preset.id,
      transport: preset.transport,
      config: replaceCanonicalRootToken(config, args.target) as Record<string, unknown>,
      enabled: true,
      createdAt: 0,
      updatedAt: 0,
    })
  }
  if (servers.length === 0) return undefined
  const adapterId = args.target === "gemini-cli" ? "gemini" : "claude-code"
  const adapter = MCP_AGENT_ADAPTERS.find((candidate) => candidate.id === adapterId)
  if (!adapter) throw new Error(`missing MCP adapter: ${adapterId}`)
  const projected = adapter.project(null, servers)
  if (!projected || typeof projected !== "object" || Array.isArray(projected)) {
    throw new Error(`${adapterId} MCP adapter returned an invalid projection`)
  }
  for (const preset of presets) {
    args.report.converted.push({
      capability: "mcp-server-preset",
      path: `mcpServerPresets.${preset.id}`,
      message: `exported MCP server ${preset.id}`,
      blocking: false,
    })
  }
  return projected as Record<string, unknown>
}

/** Native hooks are emitted through each host's dialect (see hook-dialects.ts);
 * only exact 1:1 events and handler types convert, everything else blocks. */
function exportCommandHooks(args: {
  manifest: PluginManifest
  output: Map<string, string>
  target: Exclude<PluginEcosystem, "cognia">
  report: PluginConversionReport
}): void {
  const hooks = args.manifest.commandHooks
  if (!hooks || !Object.keys(hooks).length) return
  const dialect =
    args.target === "claude-code"
      ? undefined
      : args.target === "codex"
        ? HOOK_DIALECTS.codex
        : args.target === "gemini-cli"
          ? HOOK_DIALECTS["gemini-cli"]
          : null
  if (dialect === null) {
    args.report.blocking.push({
      capability: "command-hooks",
      path: "commandHooks",
      message: `${args.target} hooks are not declarative; native export is not possible`,
      blocking: true,
    })
    return
  }
  const validated = convertHookDocuments({
    documents: [{ path: "commandHooks", value: { hooks } }],
    report: args.report,
  })
  if (dialect) {
    const projected = canonicalHooksToDialect({
      hooks: validated,
      dialect,
      sink: args.report,
      path: "hooks/hooks.json",
    })
    if (projected)
      args.output.set(
        "hooks/hooks.json",
        JSON.stringify(replaceCanonicalRootToken(projected, args.target), null, 2) + "\n"
      )
    return
  }
  for (const [event, groups] of Object.entries(hooks)) {
    for (const group of groups ?? []) {
      if (group.agents)
        args.report.blocking.push({
          capability: "command-hooks",
          path: `commandHooks.${event}`,
          message: "Claude Code cannot enforce Cognia agent selectors",
          blocking: true,
        })
      for (const handler of group.hooks) {
        if (
          !["command", "http", "prompt", "agent", "mcp_tool"].includes(handler.type) ||
          handler.policyClass === "managed"
        ) {
          args.report.blocking.push({
            capability: "command-hooks",
            path: `commandHooks.${event}`,
            message:
              "Cognia-only hook handlers and managed fail-closed policies require the Cognia host",
            blocking: true,
          })
        }
      }
    }
  }
  args.output.set(
    "hooks/hooks.json",
    JSON.stringify(replaceCanonicalRootToken({ hooks: validated }, args.target), null, 2) + "\n"
  )
}

/** Keep the payload layout intact: scripts can load dynamic sibling dependencies.
 * Copying only argv[0] cannot establish an executable dependency closure. */
function exportRuntimeResources(args: {
  manifest: PluginManifest
  files: SourceFiles
  output: Map<string, string>
  copies: Array<{ from: string; to: string }>
  target: PluginEcosystem
  report: PluginConversionReport
  binaryPaths?: ReadonlySet<string>
}): void {
  const strings: string[] = []
  const collectStrings = (value: unknown) => {
    if (typeof value === "string") strings.push(value)
    else if (Array.isArray(value)) value.forEach(collectStrings)
    else if (value && typeof value === "object") Object.values(value).forEach(collectStrings)
  }
  collectStrings([args.manifest.mcpServerPresets, args.manifest.commandHooks])
  if (!strings.some((value) => value.includes("${COGNIA_PLUGIN_ROOT}"))) return
  const payloadPaths = new Set(args.files.keys())
  for (const path of args.files.keys()) {
    const segments = path.split("/")
    for (let length = 1; length < segments.length; length++)
      payloadPaths.add(segments.slice(0, length).join("/"))
  }
  const candidates = [...payloadPaths].sort((a, b) => b.length - a.length)
  const references: string[] = []
  for (const value of strings) {
    for (const match of value.matchAll(/\$\{COGNIA_PLUGIN_ROOT\}\//g)) {
      const suffix = value.slice(match.index + match[0].length)
      const known = candidates.find(
        (path) =>
          suffix.startsWith(path) && (!suffix[path.length] || /[\s"'`;)]/.test(suffix[path.length]))
      )
      references.push(known ?? suffix.split(/["'`\r\n]/)[0])
    }
  }
  for (const reference of references) {
    const path = normalizePath(reference)
    if (!args.files.has(path) && !filesBelow(args.files, path).length)
      args.report.blocking.push({
        capability: "resources",
        path,
        message: "Plugin-relative executable or resource reference is missing from the bundle",
        blocking: true,
      })
  }
  for (const [path, text] of args.files) {
    if (
      path === "plugin.json" ||
      path === args.manifest.main ||
      (VENDOR_MANIFEST_PATHS as readonly string[]).includes(path) ||
      path === "mcp.json" ||
      /^\.cognia-normalized\//.test(path) ||
      /^\.(?:claude|codex)-plugin\//.test(path) ||
      /(^|\/)\.env(?:\.|$)/.test(path) ||
      path === ".mcp.json" ||
      path === "hooks/hooks.json" ||
      path === "hooks.json"
    )
      continue
    // The export above owns auto-discovered declarative definitions. Retain
    // their non-definition resources at their original paths for root refs.
    if (
      (path.startsWith("skills/") && path.endsWith("/SKILL.md")) ||
      (/^(?:agents|droids)\//.test(path) && path.endsWith(".md")) ||
      (path.startsWith("commands/") && /\.(?:toml|md)$/.test(path)) ||
      path.startsWith("policies/") ||
      path.startsWith("output-styles/") ||
      path.startsWith("workflows/") ||
      path === ".lsp.json" ||
      path === "settings.json"
    )
      continue
    if (args.output.has(path)) continue
    if (args.binaryPaths?.has(path)) args.copies.push({ from: path, to: path })
    else args.output.set(path, replaceCanonicalRootToken(text, args.target) as string)
  }
  for (const reference of references) {
    const path = normalizePath(reference)
    if (
      !args.output.has(path) &&
      !filesBelow(args.output, path).length &&
      !args.copies.some((copy) => copy.to === path || copy.to.startsWith(`${path}/`))
    )
      args.report.blocking.push({
        capability: "resources",
        path,
        message:
          "Referenced resource is excluded or relocated in this target bundle; update the reference before exporting",
        blocking: true,
      })
  }
  args.report.warnings.push({
    capability: "resources",
    path: ".",
    message:
      "Bundled runtime payload and dependency manifests preserved; executable installation and runtime availability require target-host verification",
    blocking: false,
  })
}

function authorForForeign(manifest: PluginManifest): Record<string, string> | undefined {
  if (!manifest.author) return undefined
  return {
    name: manifest.author.name,
    ...(manifest.author.email ? { email: manifest.author.email } : {}),
    ...(manifest.author.url ? { url: manifest.author.url } : {}),
  }
}

/** Settings an export projected into install-time configuration (Cursor variables). */
const PROJECTED_SETTINGS = new WeakMap<PluginConversionResult, Array<Record<string, unknown>>>()

interface ExportContext {
  /** The ecosystem the user asked for when `target` is an intermediate Claude export. */
  finalTarget?: Exclude<PluginEcosystem, "cognia">
  fieldProjection?: "cursor-variables"
}

function convertCogniaPlugin(
  files: SourceFiles,
  target: Exclude<PluginEcosystem, "cognia">,
  options: PluginConversionOptions,
  context: ExportContext = {}
): PluginConversionResult {
  const loaded = loadCogniaPlugin(files)
  const manifest = loaded.manifest
  const finalTarget = context.finalTarget ?? target
  const report: PluginConversionReport = {
    fidelity: "structured",
    converted: [],
    warnings: [],
    blocking: [],
  }
  const allowedCapabilities = new Set([
    "skills",
    "mcp-server-preset",
    "command-hooks",
    ...(target === "claude-code" || target === "gemini-cli" ? ["subagent"] : []),
    ...(target === "pi" ? ["pi-package"] : []),
  ])
  for (const capability of manifest.capabilities ?? []) {
    if (allowedCapabilities.has(capability)) continue
    if (capability === "pi-package")
      report.blocking.push({
        capability,
        path: "piPackages",
        message: `Pi packages install only into Pi (pi install) or load into Cognia-hosted Pi sessions; they stay in Cognia and have no ${finalTarget} equivalent`,
        blocking: true,
      })
    else report.blocking.push(unsupportedIssue(capability, finalTarget))
  }
  if (manifest.permissions?.length) {
    report.blocking.push(unsupportedIssue("permissions", finalTarget))
  }
  const executableEntries = [manifest.pythonMain, manifest.wasmMain, manifest.vscodeMain].filter(
    configured
  )
  if (executableEntries.length > 0) {
    report.blocking.push(unsupportedIssue("runtime", finalTarget))
  }
  if (manifest.main) {
    const entry = files.get(normalizePath(manifest.main))
    if (entry !== renderDist(manifest)) {
      report.blocking.push({
        capability: "runtime",
        path: manifest.main,
        message: "imperative Cognia activation code cannot be translated declaratively",
        blocking: true,
      })
    }
  }
  if (target === "pi") return exportPiPackage({ manifest, files, report, options })
  if (target === "claude-code" && finalTarget === "claude-code") {
    const { nameRule, reservedNames } = CLAUDE_FAMILY_PROFILES["claude-code"]
    for (const rule of [nameRule, reservedNames])
      if (rule && rule.pattern.test(manifest.id) !== (rule === nameRule))
        report.blocking.push({
          capability: "name",
          path: "id",
          message: rule.message,
          blocking: true,
        })
  }
  if (target === "gemini-cli" && !/^[a-zA-Z0-9-]+$/.test(manifest.id))
    report.blocking.push({
      capability: "name",
      path: "id",
      message: "Gemini extension names must match ^[a-zA-Z0-9-]+$",
      blocking: true,
    })

  const output = new Map<string, string>()
  const copies: Array<{ from: string; to: string }> = []
  exportCogniaSkills({
    manifest,
    files,
    output,
    target,
    report,
    copies,
    binaryPaths: options.binaryPaths,
  })
  exportCogniaSubagents({ manifest, output, target, report })
  const settings: Array<Record<string, unknown>> = []
  const removedValues = new Set<string>()
  const mcp = exportMcpServers({
    manifest,
    output,
    target,
    report,
    settings,
    removedValues,
    fieldProjection: context.fieldProjection,
  })
  exportCommandHooks({ manifest, output, target, report })
  exportRuntimeResources({
    manifest,
    files,
    output,
    copies,
    target,
    report,
    binaryPaths: options.binaryPaths,
  })
  for (const [path, text] of output) {
    if ([...removedValues].some((value) => text.includes(value)))
      report.blocking.push({
        capability: "secrets",
        path,
        message: "A removed MCP credential is also present in an exported resource",
        blocking: true,
      })
  }
  if (report.blocking.length > 0) {
    report.fidelity = "unsupported"
    throw new UnsupportedPluginConversionError("cognia", finalTarget, report)
  }

  const baseManifest = {
    name: manifest.id,
    version: manifest.version,
    description: manifest.description,
    author: authorForForeign(manifest),
    homepage: manifest.homepage,
    repository: manifest.repository,
    license: manifest.license,
    keywords: manifest.keywords,
  }
  if (target === "claude-code") {
    output.set(
      ".claude-plugin/plugin.json",
      `${JSON.stringify(
        {
          ...baseManifest,
          displayName: manifest.name,
          ...(manifest.skills?.length ? { skills: "./skills" } : {}),
          ...(manifest.subagents?.length ? { agents: "./agents" } : {}),
          ...(mcp ? { mcpServers: "./.mcp.json" } : {}),
        },
        null,
        2
      )}\n`
    )
    if (mcp) output.set(".mcp.json", `${JSON.stringify(mcp, null, 2)}\n`)
  } else if (target === "codex") {
    output.set(
      ".codex-plugin/plugin.json",
      `${JSON.stringify(
        {
          ...baseManifest,
          ...(manifest.skills?.length ? { skills: "./skills" } : {}),
          ...(mcp ? { mcpServers: "./.mcp.json" } : {}),
          ...(output.has("hooks/hooks.json") ? { hooks: "./hooks/hooks.json" } : {}),
          interface: {
            displayName: manifest.name,
            shortDescription: manifest.description,
          },
        },
        null,
        2
      )}\n`
    )
    if (mcp) output.set(".mcp.json", `${JSON.stringify(mcp, null, 2)}\n`)
  } else {
    const geminiServers =
      mcp && typeof mcp.mcpServers === "object" && mcp.mcpServers ? mcp.mcpServers : undefined
    output.set(
      "gemini-extension.json",
      `${JSON.stringify(
        {
          name: manifest.id,
          version: manifest.version,
          description: manifest.description,
          ...(geminiServers ? { mcpServers: geminiServers } : {}),
          ...(settings.length ? { settings } : {}),
        },
        null,
        2
      )}\n`
    )
  }

  const result: PluginConversionResult = {
    source: "cognia",
    target,
    manifest,
    files: output,
    copies,
    report,
  }
  if (context.fieldProjection && settings.length) PROJECTED_SETTINGS.set(result, settings)
  return result
}

/** Cognia → Pi: the retained package root plus Cognia skills it does not already deliver. */
function exportPiPackage(args: {
  manifest: PluginManifest
  files: SourceFiles
  report: PluginConversionReport
  options: PluginConversionOptions
}): PluginConversionResult {
  const { manifest, files, report, options } = args
  if (manifest.mcpServerPresets?.length)
    report.blocking.push({
      capability: "mcp-server-preset",
      path: "mcpServerPresets",
      message:
        "Pi core has no declarative MCP servers; an extension must call pi.registerMcpServer. Select hosted use or ship a Pi extension",
      blocking: true,
    })
  if (manifest.commandHooks && Object.keys(manifest.commandHooks).length)
    report.blocking.push({
      capability: "command-hooks",
      path: "commandHooks",
      message:
        "Pi hooks are extension event handlers (pi.on); a declarative command hook cannot become one",
      blocking: true,
    })
  let skills = manifest.skills ?? []
  const packages = manifest.piPackages ?? []
  if (packages.length === 1) {
    const classified = classifySkillsForPiPackage({
      skills,
      files,
      piPackage: packages[0],
    })
    report.blocking.push(...classified.collisions)
    for (const id of classified.delivered)
      report.converted.push({
        capability: "skills",
        path: `skills.${id}`,
        message: `skill ${id} is delivered by the retained Pi package`,
        blocking: false,
      })
    skills = classified.remaining
  }
  const exported = new Map<string, string>()
  const exportedCopies: Array<{ from: string; to: string }> = []
  exportCogniaSkills({
    manifest: { ...manifest, skills },
    files,
    output: exported,
    target: "pi",
    report,
    copies: exportedCopies,
    binaryPaths: options.binaryPaths,
  })
  const probe = new Map(exported)
  for (const copy of exportedCopies) if (!probe.has(copy.to)) probe.set(copy.to, "")
  const semantics = checkSkillSemantics(probe, "pi", "export")
  report.blocking.push(...semantics.blocking)
  report.warnings.push(...semantics.warnings)
  const plan = planPiExport({
    manifest,
    files,
    exported,
    exportedCopies,
    binaryPaths: options.binaryPaths,
    generatedEntry: renderDist(manifest),
  })
  report.converted.push(...plan.issues.converted)
  report.warnings.push(...plan.issues.warnings)
  report.blocking.push(...plan.issues.blocking)
  if (report.blocking.length > 0) {
    report.fidelity = "unsupported"
    throw new UnsupportedPluginConversionError("cognia", "pi", report)
  }
  report.warnings.push({
    capability: "compatibility",
    path: "package.json",
    message: "Native Pi installation and execution require separate verification",
    blocking: false,
  })
  return {
    source: "cognia",
    target: "pi",
    manifest,
    files: plan.files,
    copies: plan.copies,
    report,
  }
}

/** Pi package → Cognia: the package is retained in place, skills and prompts also convert. */
function convertPiPlugin(
  files: SourceFiles,
  options: PluginConversionOptions
): PluginConversionResult {
  const plan = planPiImport(files)
  const report: PluginConversionReport = {
    fidelity: plan.contextual ? "contextual" : "structured",
    converted: [...plan.issues.converted],
    warnings: [...plan.issues.warnings],
    blocking: [...plan.issues.blocking],
  }
  const semantics = checkSkillSemantics(
    files,
    "pi",
    "import",
    plan.skillFiles.filter((path) => /(^|\/)SKILL\.md$/.test(path))
  )
  report.blocking.push(...semantics.blocking)
  report.warnings.push(...semantics.warnings)
  if (report.blocking.length > 0) {
    report.fidelity = "unsupported"
    throw new UnsupportedPluginConversionError("pi", "cognia", report)
  }
  const output = cloneFiles(files)
  const converted = convertSkillFiles({
    files,
    declared: undefined,
    output,
    report,
    explicit: plan.skillFiles,
  })
  const skills = [...converted.skills]
  for (const prompt of plan.promptSkills) {
    if (skills.some((skill) => skill.id === prompt.id)) {
      report.blocking.push({
        capability: "prompts",
        path: `prompts.${prompt.id}`,
        message: `Pi prompt /${prompt.name} and a Pi skill both become Cognia skill ${prompt.id}`,
        blocking: true,
      })
      continue
    }
    skills.push(prompt)
  }
  for (const path of files.keys())
    if (isPluginEnvironmentFile(path))
      report.warnings.push({
        capability: "secrets",
        path,
        message:
          "Environment files inside the Pi package are blanked; credentials are never copied",
        blocking: false,
      })
  return finalizeForeignConversion({
    source: "pi",
    output,
    metadata: metadataFromForeignManifest(plan.metadata, "package.json"),
    contributions: {
      skills,
      subagents: [],
      presets: [],
      piPackages: [plan.piPackage],
      needsFilesystem: true,
    },
    report,
    options,
    retainSourceManifests: true,
  })
}

/** Normalized platform bundles carry only canonical keys; no Claude Code host rules apply. */
const NORMALIZED_PROFILE: ClaudeFamilyProfile = {
  ...CLAUDE_FAMILY_PROFILES["claude-code"],
  ignoredFields: {},
  blockedFields: {},
  unknownFields: "block",
  blockedPaths: [],
  requireDotSlashPaths: false,
  nameRule: { pattern: /[\s\S]*/, message: "" },
}

const ECOSYSTEM_LABELS: Record<PluginEcosystem, string> = {
  cognia: "Cognia",
  "claude-code": "Claude Code",
  codex: "Codex",
  "gemini-cli": "Gemini CLI",
  "agent-plugins": "Agent Plugins",
  cursor: "Cursor",
  copilot: "GitHub Copilot",
  kimi: "Kimi CLI",
  devin: "Devin",
  opencode: "OpenCode",
  pi: "Pi",
  "factory-droid": "Factory Droid",
  qoder: "Qoder CLI",
  codebuddy: "CodeBuddy",
  auggie: "Auggie",
  "open-plugins": "Open Plugins",
}

function isClaudeFamily(value: PluginEcosystem): value is ClaudeFamilyEcosystem {
  return value in CLAUDE_FAMILY_PROFILES
}

export function convertPluginBundle(
  files: SourceFiles,
  target: PluginEcosystem,
  options: PluginConversionOptions = {}
): PluginConversionResult {
  for (const path of files.keys()) {
    if (
      path.startsWith("/") ||
      /^[A-Za-z]:/.test(path) ||
      path.includes("\\") ||
      path.split("/").includes("..")
    ) {
      throw new Error(`plugin source path must stay relative to the bundle: ${path}`)
    }
  }
  const detected = detectPluginBundle(files)
  const source = detected.ecosystem
  const shadowWarnings: PluginConversionIssue[] = detected.shadowed.map((entry) => ({
    capability: "format",
    path: entry.path,
    message: `${ECOSYSTEM_LABELS[entry.ecosystem]} manifest is also present; this conversion reads ${detected.manifestPath} (${ECOSYSTEM_LABELS[source]}) and does not convert it`,
    blocking: false,
  }))
  let canonical: PluginConversionResult | undefined
  const platformTarget = (value: PluginEcosystem): value is PlatformBundleTarget =>
    value in PLATFORM_BUNDLE_PROFILES
  const finish = (result: PluginConversionResult): PluginConversionResult => {
    result.source = source
    result.target = target
    result.report.delivery = assessPluginDelivery({
      manifest: canonical?.manifest ?? result.manifest,
      report: result.report,
      target,
    })
    return result
  }
  try {
    if (source === "cognia") canonical = loadCogniaPlugin(files)
    else if (isClaudeFamily(source))
      canonical = convertClaudePlugin(files, options, CLAUDE_FAMILY_PROFILES[source])
    else if (source === "codex") canonical = convertCodexPlugin(files, options)
    else if (source === "gemini-cli") canonical = convertGeminiPlugin(files, options)
    else if (source === "pi") canonical = convertPiPlugin(files, options)
    else {
      const normalized = normalizePlatformBundle(files, source)
      if (normalized.blocking.length)
        throw new UnsupportedPluginConversionError(source, target, {
          fidelity: "unsupported",
          converted: [],
          warnings: [...shadowWarnings, ...normalized.warnings],
          blocking: normalized.blocking,
        })
      canonical = convertClaudePlugin(normalized.files, options, NORMALIZED_PROFILE, {
        explicitSkills: normalized.skills ?? [],
        hookDefaults: false,
        mcpMode: "replace",
        settings: normalized.settings,
        rootSkillResources: normalized.rootSkillResources,
      })
      for (const path of normalized.transient) canonical.files.delete(path)
      canonical.copies = canonical.copies.filter((copy) => !normalized.transient.has(copy.to))
      canonical.report.warnings.unshift(...normalized.warnings)
    }
    canonical.report.warnings.unshift(...shadowWarnings)
    if (target === "cognia") {
      // An imported plugin is installed as "source tree + overlay", and the
      // installers only accept generated plugin.json / dist/index.js plus
      // neutralizations of existing files. Adapter-side rewrites of source
      // files (skill frontmatter aliases) informed the canonical manifest,
      // which carries their meaning; the installed copy keeps source bytes.
      if (source !== "cognia")
        for (const [path, text] of canonical.files) {
          const original = files.get(path)
          if (original === undefined || original === text) continue
          if (!isOverlayEntryAllowed(files, path, text)) canonical.files.set(path, original)
        }
      return finish(canonical)
    }
    const exportTarget =
      platformTarget(target) || (isClaudeFamily(target) && target !== "claude-code")
        ? "claude-code"
        : target
    const result = convertCogniaPlugin(canonical.files, exportTarget, options, {
      finalTarget: target,
      fieldProjection: target === "cursor" ? "cursor-variables" : undefined,
    })
    result.report.warnings.unshift(...canonical.report.warnings)
    if (exportTarget === "claude-code" && target !== "claude-code") {
      // Binary placeholders must take part in path relocation just like text.
      const nativeFiles = new Map(result.files)
      for (const copy of result.copies) if (!nativeFiles.has(copy.to)) nativeFiles.set(copy.to, "")
      const projected = platformTarget(target)
        ? projectPlatformBundle(nativeFiles, target, {
            variables: (PROJECTED_SETTINGS.get(result) ?? []).map((setting) => ({
              envVar: String(setting.envVar),
              name: String(setting.name),
              description:
                typeof setting.description === "string" ? setting.description : undefined,
              sensitive: Boolean(setting.sensitive),
            })),
          })
        : projectClaudeFamilyBundle(
            nativeFiles,
            CLAUDE_FAMILY_PROFILES[target as ClaudeFamilyEcosystem]
          )
      result.report.warnings.push(...projected.warnings)
      result.report.blocking.push(...projected.blocking)
      if (projected.blocking.length) {
        result.report.fidelity = "unsupported"
        throw new UnsupportedPluginConversionError(source, target, result.report)
      }
      const relocated = new Map<string, string>()
      for (const copy of result.copies) {
        // Kimi moves the single skill to the plugin root; OpenCode into .opencode/.
        const to =
          target === "opencode" && copy.to.startsWith("skills/")
            ? `.opencode/${copy.to}`
            : target === "kimi" && /^skills\/[^/]+\//.test(copy.to)
              ? copy.to.replace(/^skills\/[^/]+\//, "")
              : copy.to
        relocated.set(copy.to, to)
      }
      result.files = projected.files
      result.copies = result.copies.map((copy) => ({
        ...copy,
        to: relocated.get(copy.to) ?? copy.to,
      }))
      // Explicit copies own their destination; placeholder text must not write
      // over binary data in either CLI or workspace apply.
      for (const copy of result.copies) result.files.delete(copy.to)
    }
    return finish(result)
  } catch (error) {
    if (!(error instanceof UnsupportedPluginConversionError)) throw error
    const report = { ...error.report, fidelity: "unsupported" as const }
    if (!report.warnings.some((issue) => shadowWarnings.includes(issue)))
      report.warnings = [...shadowWarnings, ...report.warnings]
    report.delivery = assessPluginDelivery({ manifest: canonical?.manifest, report, target })
    throw new UnsupportedPluginConversionError(source, target, report)
  }
}
