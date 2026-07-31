import { parseMarkdownAgent, serializeMarkdownAgent } from "@/lib/claude/agents/markdown-agents"
import { MCP_AGENT_ADAPTERS } from "@/lib/claude/agents"
import { serializeSkill } from "@/lib/claude/skills-io"
import type { PluginManifest } from "@/types/plugin/plugin"
import type { PluginMcpServerPresetDef } from "@/types/plugin/plugin-mcp-preset"
import type { PluginSkillDef } from "@/types/plugin/plugin-skill"
import type { PluginSubagentDef } from "@/types/plugin/plugin-subagent"
import type { McpServer } from "@cognia/agent-config-types"
import { parse as parseToml, stringify as stringifyToml } from "smol-toml"
import { slugify } from "./identity"
import { assembleManifest, serializeManifest, type RuntimeNeed } from "./manifest"
import { describeConfig, readMcpDrafts } from "./mcp-source"
import { parseExistingManifest } from "./merge"
import { renderDist } from "./scaffold"
import { buildSkill } from "./skill-source"

export type PluginEcosystem = "cognia" | "claude-code" | "codex" | "gemini-cli"
export type PluginConversionFidelity = "native-exact" | "structured" | "contextual" | "unsupported"

export interface PluginConversionIssue {
  capability: string
  path: string
  message: string
  blocking: boolean
}

export interface PluginConversionReport {
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

function unsupportedIssue(capability: string): PluginConversionIssue {
  return {
    capability,
    path: capability,
    message: `${capability} has no behaviorally equivalent Cognia declarative contribution`,
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

  const need: RuntimeNeed = contributions.presets.some((preset) => preset.transport === "stdio")
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
  output.set("plugin.json", serializeManifest(manifest))
  output.set("dist/index.js", renderDist(manifest))

  return {
    source,
    target: "cognia",
    manifest,
    files: output,
    copies: [],
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

function convertSkillFiles(args: {
  files: SourceFiles
  declared: unknown
  output: Map<string, string>
  report: PluginConversionReport
}): { skills: PluginSkillDef[]; needsFilesystem: boolean } {
  const { files, declared, output, report } = args
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
    const resources = directory ? filesBelow(files, directory) : []
    const built = buildSkill(text, resources, displayNameFromPath(directory || skillFile))
    if (built.skill.source.kind === "local-bundle" && directory) {
      built.skill.source = { kind: "local-bundle", path: directory }
    }
    skills.push(built.skill)
    needsFilesystem ||= built.needsFilesystem
    if (!directory) {
      for (const copy of built.copies) {
        const contents = files.get(normalizePath(copy.from))
        if (contents !== undefined) output.set(copy.to, contents)
      }
    }
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
    const { drafts } = readMcpDrafts(canonicalText, args.adapterSourceName)
    for (const draft of drafts) {
      const preset: PluginMcpServerPresetDef = {
        id: draft.name,
        name: draft.name,
        description: describeConfig(draft.transport, draft.config),
        transport: draft.transport,
        config: draft.config,
        fields: [],
      }
      presets.push(preset)
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

export function detectPluginEcosystem(files: SourceFiles): PluginEcosystem {
  if (files.has("plugin.json")) return "cognia"
  if (files.has(".claude-plugin/plugin.json")) return "claude-code"
  if (files.has(".codex-plugin/plugin.json")) return "codex"
  if (files.has("gemini-extension.json")) return "gemini-cli"
  throw new Error(
    "plugin format not recognized — expected plugin.json, .claude-plugin/plugin.json, " +
      ".codex-plugin/plugin.json, or gemini-extension.json"
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
    ["hooks", source.hooks],
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
    ["hooks", ["hooks/", "hooks.json"]],
    ["monitors", ["monitors/"]],
    ["bin", ["bin/"]],
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
  if (blocking.length > 0) {
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
    ["hooks", source.hooks],
    ["apps", source.apps],
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
      "skills",
      "hooks",
      "mcpServers",
      "apps",
      "interface",
    ]),
    sourcePath,
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
    ]),
    sourcePath,
    report,
  })
  const output = cloneFiles(files)
  const skills: PluginSkillDef[] = []
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
    report,
  })
  return finalizeForeignConversion({
    source: "gemini-cli",
    output,
    metadata: metadataFromForeignManifest(source, sourcePath),
    contributions: {
      skills,
      subagents: [],
      presets,
      needsFilesystem: false,
    },
    report,
    options,
  })
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
        : "${CODEX_PLUGIN_ROOT}"
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
    if (skill.source.kind === "inline") {
      args.output.set(
        `${targetDirectory}/SKILL.md`,
        serializeSkill({
          name: skill.name,
          description: skill.description,
          content: skill.source.markdown,
          allowedTools: skill.allowedTools,
        })
      )
    } else if (skill.source.kind === "local-folder" || skill.source.kind === "local-bundle") {
      if (args.target === "gemini-cli") {
        args.report.blocking.push({
          capability: "skills",
          path: `skills.${skill.id}.source`,
          message: "Gemini prompt commands cannot preserve a resource-bearing Cognia skill",
          blocking: true,
        })
        continue
      }
      const sourceDirectory = normalizePath(skill.source.path)
      const entries = Array.from(args.files.entries()).filter(([path]) =>
        normalizePath(path).startsWith(`${sourceDirectory}/`)
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
        const relative = normalizePath(path).slice(sourceDirectory.length + 1)
        const normalizedSource = normalizePath(path)
        const target = `${targetDirectory}/${relative}`
        if (args.binaryPaths?.has(normalizedSource)) {
          args.copies.push({ from: normalizedSource, to: target })
        } else {
          args.output.set(target, contents)
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
      message: `${args.target} plugins do not expose a compatible subagent contribution`,
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
}): Record<string, unknown> | undefined {
  const presets = args.manifest.mcpServerPresets ?? []
  if (presets.length === 0) return undefined
  const servers: McpServer[] = []
  for (const preset of presets) {
    if (preset.fields?.length) {
      args.report.blocking.push({
        capability: "mcp-server-preset",
        path: `mcpServerPresets.${preset.id}.fields`,
        message: "target plugin formats cannot prompt users for Cognia preset fields",
        blocking: true,
      })
      continue
    }
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
      config: replaceCanonicalRootToken(preset.config, args.target) as Record<string, unknown>,
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
    fidelity: target === "gemini-cli" ? "contextual" : "structured",
    converted: [],
    warnings: [],
    blocking: [],
  }
  const allowedCapabilities = new Set([
    "skills",
    "mcp-server-preset",
    ...(target === "claude-code" ? ["subagent"] : []),
  ])
  for (const capability of manifest.capabilities ?? []) {
    if (!allowedCapabilities.has(capability)) {
      report.blocking.push(unsupportedIssue(capability))
    }
  }
  if (manifest.permissions?.length) {
    report.blocking.push(unsupportedIssue("permissions"))
  }
  const executableEntries = [manifest.pythonMain, manifest.wasmMain, manifest.vscodeMain].filter(
    configured
  )
  if (executableEntries.length > 0) {
    report.blocking.push(unsupportedIssue("runtime"))
  }
  if (manifest.main) {
    const entry = files.get(normalizePath(manifest.main))
    if (!entry?.includes("Built output of src/index.ts, pre-generated by `cognia plugin import`")) {
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
  const mcp = exportMcpServers({ manifest, output, target, report })
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
    for (const skill of manifest.skills ?? []) {
      const skillFile = output.get(`skills/${skill.id}/SKILL.md`)
      if (skillFile === undefined) continue
      const parsed = buildSkill(skillFile, [], skill.name).skill
      const markdown = parsed.source.kind === "inline" ? parsed.source.markdown : skillFile
      output.set(
        `commands/${skill.id}.toml`,
        stringifyToml({
          description: skill.description,
          prompt: markdown,
        })
      )
      report.warnings.push({
        capability: "skills",
        path: `skills.${skill.id}`,
        message: "exported as a Gemini prompt command; autonomous skill activation is contextual",
        blocking: false,
      })
    }
    for (const path of Array.from(output.keys())) {
      if (path.startsWith("skills/")) output.delete(path)
    }
    output.set(
      "gemini-extension.json",
      `${JSON.stringify(
        {
          name: manifest.id,
          version: manifest.version,
          description: manifest.description,
          ...(geminiServers ? { mcpServers: geminiServers } : {}),
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
  const source = detectPluginEcosystem(files)
  if (source === target && source === "cognia") return loadCogniaPlugin(files)
  if (source === "claude-code" && target === "cognia") {
    return convertClaudePlugin(files, options)
  }
  if (source === "codex" && target === "cognia") {
    return convertCodexPlugin(files, options)
  }
  if (source === "gemini-cli" && target === "cognia") {
    return convertGeminiPlugin(files, options)
  }
  if (source === "cognia" && target !== "cognia") {
    return convertCogniaPlugin(files, target, options)
  }
  const report: PluginConversionReport = {
    fidelity: "unsupported",
    converted: [],
    warnings: [],
    blocking: [
      {
        capability: "format",
        path: source,
        message: `conversion from ${source} to ${target} is not implemented`,
        blocking: true,
      },
    ],
  }
  throw new UnsupportedPluginConversionError(source, target, report)
}
