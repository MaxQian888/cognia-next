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
import { isPluginEnvironmentFile } from "./source-snapshot"
import {
  detectPlatformBundle,
  normalizePlatformBundle,
  projectPlatformBundle,
  PLATFORM_BUNDLE_PROFILES,
  type PlatformBundleTarget,
} from "./platform-bundles"

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

interface ClaudePluginManifest {
  name?: unknown
  displayName?: unknown
  version?: unknown
  description?: unknown
  author?: unknown
  homepage?: unknown
  repository?: unknown
  license?: unknown
  keywords?: unknown
  skills?: unknown
  commands?: unknown
  agents?: unknown
  mcpServers?: unknown
  hooks?: unknown
  lspServers?: unknown
  outputStyles?: unknown
  workflows?: unknown
  settings?: unknown
  userConfig?: unknown
  channels?: unknown
  dependencies?: unknown
  experimental?: unknown
}

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

function replacePluginRootToken(value: unknown): unknown {
  if (typeof value === "string") {
    return value
      .replaceAll("${CLAUDE_PLUGIN_ROOT}", "${COGNIA_PLUGIN_ROOT}")
      .replaceAll("${CODEX_PLUGIN_ROOT}", "${COGNIA_PLUGIN_ROOT}")
      .replaceAll("${PLUGIN_ROOT}", "${COGNIA_PLUGIN_ROOT}")
      .replaceAll("${extensionPath}", "${COGNIA_PLUGIN_ROOT}")
  }
  if (Array.isArray(value)) return value.map(replacePluginRootToken)
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, replacePluginRootToken(item)])
    )
  }
  return value
}

const UNSUPPORTED_RUNTIME_TOKENS = [
  "${PLUGIN_DATA}",
  "${CLAUDE_PLUGIN_DATA}",
  "${CLAUDE_PROJECT_DIR}",
  "${workspacePath}",
] as const

function rejectUnsupportedRuntimeTokens(args: {
  text: string
  capability: string
  path: string
  report: PluginConversionReport
}): boolean {
  const found = UNSUPPORTED_RUNTIME_TOKENS.filter((token) => args.text.includes(token))
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
    homepage: optionalString(manifest.homepage) ?? optionalString(interfaceMetadata?.websiteURL),
    repository: optionalString(manifest.repository),
    keywords: stringArray(manifest.keywords),
    icon:
      optionalString(interfaceMetadata?.logo) ?? optionalString(interfaceMetadata?.composerIcon),
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

  const need: RuntimeNeed =
    hasCommandHooks || contributions.presets.some((preset) => preset.transport === "stdio")
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
  for (const path of [
    ".claude-plugin/plugin.json",
    ".codex-plugin/plugin.json",
    "gemini-extension.json",
  ])
    if (output.has(path)) output.set(path, "{}\n")
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

function collectSkillMarkdownFiles(files: SourceFiles, declared: unknown): string[] {
  const declaredPaths = pathList(declared)
  const roots = declaredPaths.length > 0 ? declaredPaths : ["skills"]
  const result = new Set<string>()
  for (const root of roots) {
    if (/\.md$/i.test(root)) {
      if (files.has(root)) result.add(root)
      continue
    }
    if (files.has(`${root}/SKILL.md`)) {
      result.add(`${root}/SKILL.md`)
      continue
    }
    for (const path of files.keys()) {
      const normalized = normalizePath(path)
      if (normalized.startsWith(`${root}/`) && normalized.endsWith("/SKILL.md")) {
        result.add(normalized)
      }
    }
  }
  return Array.from(result).sort()
}

/** Root skills share a plugin directory; package controls are not skill resources. */
function rootSkillFiles(files: SourceFiles, runtimeEntry?: string): string[] {
  return [...files.keys()].filter(
    (path) =>
      path !== runtimeEntry &&
      !isPluginEnvironmentFile(path) &&
      !/^(?:\.(?:claude|codex|cursor|kimi|devin)-plugin\/|\.github\/|\.opencode\/|(?:skills|agents|commands|hooks|policies|output-styles|workflows)\/|(?:plugin|kimi\.plugin|gemini-extension|mcp|\.mcp|hooks|settings|opencode)\.jsonc?$)/.test(
        path
      )
  )
}

function convertSkillFiles(args: {
  files: SourceFiles
  declared: unknown
  output: Map<string, string>
  report: PluginConversionReport
}): { skills: PluginSkillDef[]; needsFilesystem: boolean } {
  const { files, declared, report } = args
  const paths = collectSkillMarkdownFiles(files, declared)
  if (!configured(declared) && files.has("SKILL.md")) paths.unshift("SKILL.md")
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
    const directory = skillFile.slice(0, Math.max(0, skillFile.lastIndexOf("/")))
    const resources = directory ? filesBelow(files, directory) : rootSkillFiles(files)
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
  rootKey = "mcpServers"
): Array<{ path: string; value: Record<string, unknown> }> {
  if (declared && typeof declared === "object" && !Array.isArray(declared)) {
    const record = declared as Record<string, unknown>
    return [
      {
        path: rootKey,
        value: rootKey in record ? record : { [rootKey]: record },
      },
    ]
  }
  const paths = pathList(declared)
  if (paths.length === 0 && files.has(defaultPath)) paths.push(defaultPath)
  return paths.map((path) => {
    const text = files.get(path)
    if (text === undefined) throw new Error(`declared MCP configuration was not found: ${path}`)
    return { path, value: parseJsonObject(text, path) }
  })
}

function convertMcpDocuments(args: {
  documents: Array<{ path: string; value: Record<string, unknown> }>
  adapterSourceName: string
  output: Map<string, string>
  report: PluginConversionReport
}): PluginMcpServerPresetDef[] {
  const presets: PluginMcpServerPresetDef[] = []
  for (const document of args.documents) {
    rejectUnsupportedRuntimeTokens({
      text: JSON.stringify(document.value),
      capability: "mcpServers",
      path: document.path,
      report: args.report,
    })
    const canonicalText = JSON.stringify(replacePluginRootToken(document.value))
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
    for (const path of [
      ".claude-plugin/plugin.json",
      ".codex-plugin/plugin.json",
      "gemini-extension.json",
    ])
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
  if (args.defaultDiscovery !== false) {
    addFile("hooks/hooks.json")
    addFile("hooks.json")
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
}): HooksConfig {
  const { documents, report } = args
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
    const canonical = replacePluginRootToken(document.value) as Record<string, unknown>
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
  const rootText = files.get("plugin.json")
  if (rootText !== undefined) {
    const root = parseJsonObject(rootText, "plugin.json")
    // Converted packages retain neutralized source markers. The canonical
    // Cognia identity wins over those inert overlay files.
    if (typeof root.id === "string" && typeof root.type === "string") return "cognia"
  }
  const markers: Array<[string, PluginEcosystem]> = [
    [".claude-plugin/plugin.json", "claude-code"],
    [".codex-plugin/plugin.json", "codex"],
    ["gemini-extension.json", "gemini-cli"],
    [".cursor-plugin/plugin.json", "cursor"],
    [".github/plugin/plugin.json", "copilot"],
    [".github/plugin.json", "copilot"],
    ["kimi.plugin.json", "kimi"],
    [".kimi-plugin/plugin.json", "kimi"],
    [".devin-plugin/plugin.json", "devin"],
    ["opencode.json", "opencode"],
    ["opencode.jsonc", "opencode"],
  ]
  const candidates = markers.filter(([path]) => files.has(path))
  const active = candidates.filter(([path]) => !/^\s*\{\s*\}\s*$/.test(files.get(path)!))
  const formats = [...new Set((active.length ? active : candidates).map(([, format]) => format))]
  if (formats.length > 1)
    throw new Error("multiple plugin formats found; provide one unambiguous plugin bundle")
  const platformFiles = new Map(files)
  for (const [path] of candidates)
    if (!active.some(([entry]) => entry === path)) platformFiles.delete(path)
  const platform = detectPlatformBundle(platformFiles)
  if (platform) {
    if (formats.length && formats[0] !== platform)
      throw new Error("multiple plugin formats found; provide one unambiguous plugin bundle")
    return platform
  }
  if (formats.length) return formats[0]
  if (rootText !== undefined) {
    const root = parseJsonObject(rootText, "plugin.json")
    if (root.$schema)
      throw new Error("plugin.json schema is not a recognized Cognia or Agent Plugins format")
    return "cognia"
  }
  throw new Error(
    "plugin format not recognized — provide a Cognia, Agent Plugins, Claude Code, Codex, Gemini, Cursor, Copilot, Kimi, Devin, OpenCode or Pi bundle"
  )
}

function convertClaudePlugin(
  files: SourceFiles,
  options: PluginConversionOptions
): PluginConversionResult {
  const sourcePath = ".claude-plugin/plugin.json"
  const source = parseJsonObject(
    requiredString(files.get(sourcePath), sourcePath),
    sourcePath
  ) as ClaudePluginManifest
  const sourceRecord = source as Record<string, unknown>

  const blocking = [
    ["lspServers", source.lspServers],
    ["outputStyles", source.outputStyles],
    ["workflows", source.workflows],
    ["settings", source.settings],
    ["userConfig", source.userConfig],
    ["channels", source.channels],
    ["dependencies", source.dependencies],
    ["experimental", source.experimental],
  ]
    .filter(([, value]) => configured(value))
    .map(([capability]) => unsupportedIssue(String(capability)))
  const discoveredExecutableSurfaces = [
    ["monitors", ["monitors/"]],
    ["themes", ["themes/"]],
    ["workflows", ["workflows/"]],
    ["outputStyles", ["output-styles/"]],
    ["settings", ["settings.json"]],
    ["lspServers", [".lsp.json"]],
  ] as const
  for (const [capability, prefixes] of discoveredExecutableSurfaces) {
    if (
      prefixes.some((prefix) =>
        Array.from(files.keys()).some((path) =>
          prefix.endsWith("/")
            ? normalizePath(path).startsWith(prefix)
            : normalizePath(path) === prefix
        )
      ) &&
      !blocking.some((issue) => issue.capability === capability)
    ) {
      blocking.push(unsupportedIssue(capability))
    }
  }

  const report: PluginConversionReport = {
    fidelity: blocking.length > 0 ? "unsupported" : "structured",
    converted: [],
    warnings: [],
    blocking,
  }
  reportUnknownManifestFields({
    manifest: sourceRecord,
    known: new Set([
      "name",
      "displayName",
      "version",
      "description",
      "author",
      "homepage",
      "repository",
      "license",
      "keywords",
      "skills",
      "commands",
      "agents",
      "mcpServers",
      "hooks",
      "lspServers",
      "outputStyles",
      "workflows",
      "settings",
      "userConfig",
      "channels",
      "dependencies",
      "experimental",
    ]),
    sourcePath,
    report,
  })
  // Hooks convert rather than block: `hooks.json` files, plus a manifest
  // `hooks` path/inline map, land in `manifest.commandHooks`. Run this before
  // the early throw so unmappable hook surfaces (PostMarketplace, `plugin`
  // handlers, unsupported runtime tokens) surface alongside the other
  // blockers in one report instead of a second failed attempt.
  const commandHooks = convertHookDocuments({
    documents: collectHookDocuments({
      files,
      declared: source.hooks,
      sourcePath,
      report,
    }),
    report,
  })
  // `report.blocking` aliases the surface list above plus anything the hook
  // conversion appended, so one check covers both.
  if (report.blocking.length > 0) {
    throw new UnsupportedPluginConversionError("claude-code", "cognia", report)
  }

  const output = cloneFiles(files)
  const convertedSkills = convertSkillFiles({
    files,
    declared: source.skills,
    output,
    report,
  })
  const skills = convertedSkills.skills

  const commandConversionStart = report.converted.length
  const commandPaths = pathList(source.commands, "commands")
  for (const path of commandPaths) {
    const candidates = path.toLowerCase().endsWith(".md")
      ? [path]
      : Array.from(files.keys()).filter(
          (file) => normalizePath(file).startsWith(`${path}/`) && /\.md$/i.test(file)
        )
    for (const commandPath of candidates) {
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
        report.blocking.push({ capability: "commands", path: commandPath, message, blocking: true })
      skills.push(built.skill)
      report.converted.push({
        capability: "commands",
        path: commandPath,
        message: `converted prompt command to skill ${built.skill.id}`,
        blocking: false,
      })
    }
  }
  if (configured(source.commands) && report.converted.length === commandConversionStart) {
    report.blocking.push({
      capability: "commands",
      path: "commands",
      message: "declared command paths did not contain Markdown command files",
      blocking: true,
    })
  }

  const subagents: PluginSubagentDef[] = []
  const agentConversionStart = report.converted.length
  const agentPaths = pathList(source.agents, "agents")
  for (const path of agentPaths) {
    const candidates = path.toLowerCase().endsWith(".md")
      ? [path]
      : Array.from(files.keys()).filter(
          (file) => normalizePath(file).startsWith(`${path}/`) && /\.md$/i.test(file)
        )
    for (const agentPath of candidates) {
      const text = files.get(agentPath)
      if (text === undefined) continue
      rejectUnsupportedRuntimeTokens({
        text,
        capability: "agents",
        path: agentPath,
        report,
      })
      const agentId = slugify(displayNameFromPath(agentPath))
      const parsed = parseMarkdownAgent(agentId, text)
      if ("error" in parsed) {
        report.blocking.push({
          capability: "agents",
          path: agentPath,
          message: parsed.error,
          blocking: true,
        })
        continue
      }
      if (parsed.unsupportedFields.length > 0) {
        report.blocking.push({
          capability: "agents",
          path: agentPath,
          message: `unsupported subagent fields: ${parsed.unsupportedFields.join(", ")}`,
          blocking: true,
        })
        continue
      }
      subagents.push({
        id: parsed.id,
        name: parsed.id,
        ...parsed.def,
      })
      report.converted.push({
        capability: "agents",
        path: agentPath,
        message: `converted subagent ${parsed.id}`,
        blocking: false,
      })
    }
  }
  if (configured(source.agents) && report.converted.length === agentConversionStart) {
    report.blocking.push({
      capability: "agents",
      path: "agents",
      message: "declared agent paths did not contain valid Markdown agents",
      blocking: true,
    })
  }

  const presets = convertMcpDocuments({
    documents: mcpDocuments(files, source.mcpServers, ".mcp.json"),
    adapterSourceName: "claude-code.json",
    output,
    report,
  })
  return finalizeForeignConversion({
    source: "claude-code",
    output,
    metadata: metadataFromForeignManifest(sourceRecord, sourcePath),
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
  const blocking = [["apps", source.apps]]
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
      "skills",
      "hooks",
      "mcpServers",
      "apps",
      "interface",
    ]),
    sourcePath,
    report,
  })
  // Same conversion as the Claude path — `.codex-plugin` manifests carry the
  // same hooks.json convention (see `convertClaudePlugin`).
  const commandHooks = convertHookDocuments({
    documents: collectHookDocuments({
      files,
      declared: source.hooks,
      sourcePath,
      report,
      defaultDiscovery: source.hooks === undefined,
    }),
    report,
  })
  const output = cloneFiles(files)
  const convertedSkills = convertSkillFiles({
    files,
    declared: source.skills,
    output,
    report,
  })
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
  if (
    interfaceMetadata &&
    !optionalString(source.homepage) &&
    optionalString(interfaceMetadata.websiteURL)
  ) {
    mappedInterfaceFields.add("websiteURL")
  }
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
      skills: convertedSkills.skills,
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
  const blocking = configured(source.excludeTools) ? [unsupportedIssue("excludeTools")] : []
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
    ]),
    sourcePath,
    report,
  })
  const output = cloneFiles(files)
  const convertedSkills = convertSkillFiles({ files, declared: undefined, output, report })
  const skills: PluginSkillDef[] = [...convertedSkills.skills]
  for (const directory of ["hooks", "agents", "policies"]) {
    if (filesBelow(files, directory).length)
      report.blocking.push({
        capability: directory,
        path: `${directory}/`,
        message: `Gemini ${directory} use platform-specific event, execution, or policy semantics; a Cognia adapter is not implemented`,
        blocking: true,
      })
  }
  const contextPath = optionalString(source.contextFileName) ?? "GEMINI.md"
  const context = files.get(normalizePath(contextPath))
  if (context !== undefined && context.trim()) {
    rejectUnsupportedRuntimeTokens({
      text: context,
      capability: "context",
      path: contextPath,
      report,
    })
    skills.push({
      id: "gemini-context",
      name: "Gemini Context",
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

  for (const path of Array.from(files.keys()).map(normalizePath).sort()) {
    if (!path.startsWith("commands/") || !path.endsWith(".toml")) continue
    const skill = parseGeminiCommand(path, requiredString(files.get(path), path), report)
    if (skill) skills.push(skill)
  }
  if (report.warnings.some((issue) => issue.capability === "commands")) {
    report.fidelity = "contextual"
  }

  const presets = convertMcpDocuments({
    documents: mcpDocuments(files, source.mcpServers, ".mcp.json"),
    adapterSourceName: "gemini.json",
    output,
    report,
  })
  importGeminiSettings({ settings: source.settings, presets, source, report })
  return finalizeForeignConversion({
    source: "gemini-cli",
    output,
    metadata: metadataFromForeignManifest(source, sourcePath),
    contributions: {
      skills,
      subagents: [],
      presets,
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
  const servers = args.source.mcpServers as Record<string, Record<string, unknown>> | undefined
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
    const reference = "${" + variable + "}"
    let used = false
    for (const preset of args.presets) {
      const original = servers?.[preset.id] ?? {}
      const fields = (preset.fields ??= [])
      const add = (field: NonNullable<PluginMcpServerPresetDef["fields"]>[number]) => {
        const existing = fields.findIndex(
          (candidate) => candidate.placement === field.placement && candidate.key === field.key
        )
        const mapped = {
          ...field,
          label,
          ...(optionalString(setting.description)
            ? { description: optionalString(setting.description) }
            : {}),
          secret: Boolean(setting.sensitive),
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
      // Gemini also exposes declared settings directly to local server processes.
      if (preset.transport === "stdio" && !(variable in (env ?? {}))) {
        preset.config.env = {
          ...((preset.config.env as Record<string, unknown>) ?? {}),
          [variable]: "",
        }
        add({ key: variable, label, placement: "env" })
      }
    }
    if (!used)
      args.report.warnings.push({
        capability: "settings",
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
  if (args.target !== "claude-code") {
    args.report.blocking.push({
      capability: "subagent",
      path: "subagents",
      message: `${args.target} subagent execution and routing require a dedicated adapter; native export is not implemented`,
      blocking: true,
    })
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
}): Record<string, unknown> | undefined {
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
    if (fields.length && args.target !== "gemini-cli") {
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
          "Gemini requests these settings during installation; values must be supplied before use",
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

/** Native hooks are only emitted where Cognia shares the Claude hook contract.
 * Gemini event renaming is deliberately not an adapter: payloads and decisions differ. */
function exportCommandHooks(args: {
  manifest: PluginManifest
  output: Map<string, string>
  target: Exclude<PluginEcosystem, "cognia">
  report: PluginConversionReport
}): void {
  const hooks = args.manifest.commandHooks
  if (!hooks || !Object.keys(hooks).length) return
  if (args.target !== "claude-code") {
    args.report.blocking.push({
      capability: "command-hooks",
      path: "commandHooks",
      message: `${args.target} hooks require an event/payload/decision adapter; native export is not implemented`,
      blocking: true,
    })
    return
  }
  const validated = convertHookDocuments({
    documents: [{ path: "commandHooks", value: { hooks } }],
    report: args.report,
  })
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
          !["command", "http", "prompt", "agent"].includes(handler.type) ||
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
      path === "gemini-extension.json" ||
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
      (path.startsWith("agents/") && path.endsWith(".md")) ||
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

function convertCogniaPlugin(
  files: SourceFiles,
  target: Exclude<PluginEcosystem, "cognia">,
  options: PluginConversionOptions
): PluginConversionResult {
  const loaded = loadCogniaPlugin(files)
  const { manifest } = loaded
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
    ...(target === "claude-code" ? ["subagent"] : []),
  ])
  for (const capability of manifest.capabilities ?? []) {
    if (!allowedCapabilities.has(capability)) {
      report.blocking.push(unsupportedIssue(capability, target))
    }
  }
  if (manifest.permissions?.length) {
    report.blocking.push(unsupportedIssue("permissions", target))
  }
  const executableEntries = [manifest.pythonMain, manifest.wasmMain, manifest.vscodeMain].filter(
    configured
  )
  if (executableEntries.length > 0) {
    report.blocking.push(unsupportedIssue("runtime", target))
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
  const mcp = exportMcpServers({ manifest, output, target, report, settings, removedValues })
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
    throw new UnsupportedPluginConversionError("cognia", target, report)
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

  return {
    source: "cognia",
    target,
    manifest,
    files: output,
    copies,
    report,
  }
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
  const source = detectPluginEcosystem(files)
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
    else if (source === "claude-code") canonical = convertClaudePlugin(files, options)
    else if (source === "codex") canonical = convertCodexPlugin(files, options)
    else if (source === "gemini-cli") canonical = convertGeminiPlugin(files, options)
    else {
      const normalized = normalizePlatformBundle(files, source)
      if (normalized.blocking.length)
        throw new UnsupportedPluginConversionError(source, target, {
          fidelity: "unsupported",
          converted: [],
          warnings: normalized.warnings,
          blocking: normalized.blocking,
        })
      canonical = convertClaudePlugin(normalized.files, options)
      canonical.report.warnings.unshift(...normalized.warnings)
    }
    if (target === "cognia") return finish(canonical)
    const exportTarget = platformTarget(target) ? "claude-code" : target
    const result = convertCogniaPlugin(canonical.files, exportTarget, options)
    result.report.warnings.unshift(...canonical.report.warnings)
    if (platformTarget(target)) {
      // Binary placeholders must take part in path relocation just like text.
      const nativeFiles = new Map(result.files)
      for (const copy of result.copies) if (!nativeFiles.has(copy.to)) nativeFiles.set(copy.to, "")
      const projected = projectPlatformBundle(nativeFiles, target)
      result.report.warnings.push(...projected.warnings)
      result.report.blocking.push(...projected.blocking)
      if (projected.blocking.length) {
        result.report.fidelity = "unsupported"
        throw new UnsupportedPluginConversionError(source, target, result.report)
      }
      result.files = projected.files
      result.copies = result.copies.map((copy) => ({
        ...copy,
        to:
          target === "opencode" && copy.to.startsWith("skills/") ? `.opencode/${copy.to}` : copy.to,
      }))
      // Explicit copies own their destination; placeholder text must not write
      // over binary data in either CLI or workspace apply.
      for (const copy of result.copies) result.files.delete(copy.to)
    }
    return finish(result)
  } catch (error) {
    if (!(error instanceof UnsupportedPluginConversionError)) throw error
    const report = { ...error.report, fidelity: "unsupported" as const }
    report.delivery = assessPluginDelivery({ manifest: canonical?.manifest, report, target })
    throw new UnsupportedPluginConversionError(source, target, report)
  }
}
