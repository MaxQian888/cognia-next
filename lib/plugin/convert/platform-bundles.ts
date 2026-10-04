/**
 * Native package adapters for hosts whose plugin layout is not a Claude Code
 * superset: Agent Plugins (1.0.0 / 1.1.0) and its client namespaces, GitHub
 * Copilot CLI (Agent Plugins or the legacy manifest), Cursor, Kimi CLI, Devin
 * and OpenCode. Each adapter normalizes a native bundle into the canonical
 * Claude layout the Claude reader consumes (import), or projects a validated
 * Claude export into the native layout (export).
 *
 * A supported package shape does not imply runtime equivalence: everything
 * without a verified behavioral mapping is blocking, presentation-only data is
 * a warning, and nothing is executed.
 *
 * Sources (researched 2026-10-02): agentplugins/agent-plugins-spec (1.0.0
 * Published, 1.1.0 Working Draft), docs.github.com Copilot CLI plugin and hooks
 * references, cursor.com/docs/reference/plugins, MoonshotAI/kimi-cli 1.52.0
 * docs/en/customization/plugins.md, docs.devin.ai/cli/extensibility/plugins,
 * opencode.ai/docs (OpenCode 1.18.34).
 */
import matter from "gray-matter"
import { parseJsonc } from "@/lib/jsonc"
import type { HooksConfig } from "@/lib/claude/hooks"
import {
  HOOK_DIALECTS,
  canonicalHooksToDialect,
  hookDocumentToCanonical,
  type HookDialect,
} from "./hook-dialects"
import { replaceRootTokens } from "./claude-family"
import { detectPluginBundle } from "./bundle-detection"

export type PlatformBundleTarget =
  "agent-plugins" | "cursor" | "copilot" | "kimi" | "devin" | "opencode"

export interface PlatformBundleIssue {
  capability: string
  path: string
  message: string
  blocking: boolean
}

/** One install-time setting that becomes a Cognia preset field. */
export interface PlatformInstallSetting {
  envVar: string
  name: string
  description?: string
  sensitive: boolean
}

export interface PlatformBundleProjection {
  files: Map<string, string>
  blocking: PlatformBundleIssue[]
  warnings: PlatformBundleIssue[]
  /** Paths written only for the canonical reader; removed after import. */
  transient: Set<string>
  /** Skill files the host loads (import only). */
  skills?: string[]
  /** Install-time settings referenced by MCP servers (import: Cursor variables). */
  settings?: { declarations: PlatformInstallSetting[]; servers: Record<string, unknown> }
  /** Resources of a root SKILL.md when the host treats the whole directory as the skill (Kimi). */
  rootSkillResources?: string[]
}

export const AGENT_PLUGINS_SCHEMA_VERSIONS = ["1.0.0", "1.1.0"] as const
const AP_PLUGIN_SCHEMA = (version: string) =>
  `https://agent-plugins.org/schemas/${version}/plugin.schema.json`
const AP_MCP_SCHEMA = (version: string) =>
  `https://agent-plugins.org/schemas/${version}/mcp.schema.json`
/** Export writes the Published 1.0.0 schema; 1.1.0 is a Working Draft with identical text. */
export const AGENT_PLUGINS_SCHEMA = AP_PLUGIN_SCHEMA("1.0.0")
const CLAUDE_MANIFEST = ".claude-plugin/plugin.json"
const NORMALIZED = ".cognia-normalized"
const METADATA = [
  "name",
  "version",
  "description",
  "author",
  "homepage",
  "repository",
  "license",
  "keywords",
]
const AP_NAME = /^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/

export const PLATFORM_BUNDLE_PROFILES = {
  "agent-plugins": {
    manifest: "plugin.json",
    surfaces: ["cli", "desktop"],
    skills: "native",
    mcp: "native",
    agents: "client-namespace",
    hooks: "client-namespace",
  },
  cursor: {
    manifest: ".cursor-plugin/plugin.json",
    surfaces: ["desktop"],
    skills: "native",
    mcp: "native",
    agents: "native",
    hooks: "event-map",
  },
  copilot: {
    manifest: "plugin.json",
    surfaces: ["cli", "desktop", "cloud"],
    skills: "native",
    mcp: "native",
    agents: "client-namespace",
    hooks: "host-contract",
  },
  kimi: {
    manifest: "plugin.json",
    surfaces: ["cli"],
    skills: "root-skill-only",
    mcp: "unsupported",
    agents: "unsupported",
    hooks: "unsupported",
  },
  devin: {
    manifest: ".devin-plugin/plugin.json",
    surfaces: ["cli", "desktop", "cloud"],
    skills: "native",
    mcp: "native",
    agents: "local-only",
    hooks: "local-fail-open",
  },
  opencode: {
    manifest: "opencode.json",
    surfaces: ["cli"],
    skills: "native",
    mcp: "native",
    agents: "subagent-mode-only",
    hooks: "runtime-port-required",
  },
} as const

type Files = ReadonlyMap<string, string>
type Json = Record<string, unknown>

function object(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function read(files: Files, path: string): Json {
  const text = files.get(path) ?? "{}"
  const value: unknown = path.endsWith(".jsonc") ? parseJsonc(text) : JSON.parse(text)
  if (!object(value)) throw new Error(`${path} must contain an object`)
  return value
}

function present(value: unknown): boolean {
  return (
    value !== undefined &&
    value !== null &&
    value !== false &&
    value !== "" &&
    (!Array.isArray(value) || value.length > 0) &&
    (!object(value) || Object.keys(value).length > 0)
  )
}

function block(
  result: Pick<PlatformBundleProjection, "blocking">,
  capability: string,
  path: string,
  message: string
): void {
  result.blocking.push({ capability, path, message, blocking: true })
}

function warn(
  result: Pick<PlatformBundleProjection, "warnings">,
  capability: string,
  path: string,
  message: string
): void {
  result.warnings.push({ capability, path, message, blocking: false })
}

function save(files: Map<string, string>, path: string, value: Json): void {
  files.set(path, `${JSON.stringify(value, null, 2)}\n`)
}

function emptyProjection(files: Files): PlatformBundleProjection {
  return { files: new Map(files), blocking: [], warnings: [], transient: new Set() }
}

function stripDot(path: string): string {
  return path.replace(/^\.\//, "").replace(/\/+$/, "")
}

function pathsOf(value: unknown): string[] {
  return (typeof value === "string" ? [value] : Array.isArray(value) ? value : [])
    .filter((entry): entry is string => typeof entry === "string")
    .map(stripDot)
}

/** Root plugin.json is portable only with a recognized schema family, never by filename alone. */
export function detectPlatformBundle(files: Files): PlatformBundleTarget | null {
  try {
    const detected = detectPluginBundle(files).ecosystem
    return detected in PLATFORM_BUNDLE_PROFILES ? (detected as PlatformBundleTarget) : null
  } catch {
    return null
  }
}

function manifestPath(files: Files, target: PlatformBundleTarget): string {
  if (target === "copilot") {
    if (files.has("plugin.json")) return "plugin.json"
    return ".github/plugin/plugin.json"
  }
  if (target === "opencode" && !files.has("opencode.json")) return "opencode.jsonc"
  return PLATFORM_BUNDLE_PROFILES[target].manifest
}

/** Conventional surfaces each target cannot convert on its own terms. */
const UNMAPPED_SURFACES: Record<PlatformBundleTarget, ReadonlyArray<[RegExp, string, string]>> = {
  "agent-plugins": [
    [
      /^(?:agents|commands|hooks|rules|prompts|extensions|themes|output-styles)\//,
      "platform-control",
      "Agent Plugins hosts do not load root-level agents, commands, hooks or rules; client-specific components belong in a reverse-domain namespace directory",
    ],
    [
      /^(?:hooks|lsp|\.lsp|\.app)\.json$/,
      "platform-control",
      "Agent Plugins defines no portable hooks, LSP or app files",
    ],
    [
      /^(?:AGENTS|CLAUDE|GEMINI)\.md$/,
      "rules",
      "Always-on instruction files are not part of an Agent Plugins bundle",
    ],
  ],
  copilot: [
    [
      /^(?:hooks\.json|hooks\/hooks\.json)$/,
      "hooks",
      "Copilot hook files use Copilot's own contract (version 1, flat bash/powershell entries, preToolUse fail-closed on non-zero exit); no exact Cognia mapping exists",
    ],
    [
      /^(?:lsp|\.lsp)\.json$|^\.github\/lsp\.json$|^lsp-config\//,
      "lspServers",
      "LSP servers need a language-server host; Cognia has no plugin LSP contribution",
    ],
    [
      /^(?:rules|extensions|prompts|themes|output-styles)\//,
      "platform-control",
      "Copilot rules and extensions have no Cognia equivalent",
    ],
    [
      /^(?:AGENTS|CLAUDE|GEMINI)\.md$/,
      "rules",
      "Always-on instruction files have no Cognia plugin equivalent",
    ],
  ],
  cursor: [
    [
      /^rules\//,
      "rules",
      "Cursor rules apply as persistent context (alwaysApply / globs); a Cognia skill only loads on demand, so the guidance would stop applying automatically",
    ],
    [
      /^(?:policies|extensions|prompts|themes|output-styles)\//,
      "platform-control",
      "No Cognia equivalent for this Cursor surface",
    ],
    [
      /^(?:AGENTS|CLAUDE|GEMINI)\.md$/,
      "rules",
      "Always-on instruction files have no Cognia plugin equivalent",
    ],
  ],
  // Kimi reads plugin.json and a root SKILL.md only: every other file is an
  // inert resource of that skill, so nothing else needs a mapping.
  kimi: [],
  devin: [
    [
      /^AGENTS\.md$/,
      "rules",
      "Devin injects AGENTS.md as an always-on rule in every session; Cognia plugins have no always-on rule contribution",
    ],
    [
      /^rules\//,
      "rules",
      "Devin rules load by trigger frontmatter; Cognia plugins have no rule contribution",
    ],
    [
      /^agents\//,
      "agents",
      "Devin plugin subagents load only in local Devin agents; their routing has no verified Cognia equivalent",
    ],
    [
      /^(?:hooks\.json|hooks\/)/,
      "hooks",
      "Devin plugin hooks run best-effort and fail open in local sessions only; Cognia would run them on every surface",
    ],
    [
      /^(?:commands|policies|extensions|prompts|themes|output-styles)\//,
      "platform-control",
      "No Cognia equivalent for this Devin surface",
    ],
    [
      /^(?:lsp|\.lsp|\.app)\.json$/,
      "platform-control",
      "No Cognia equivalent for this Devin surface",
    ],
  ],
  opencode: [
    [
      /^\.opencode\/(?:modes?|plugins?|tools?|themes?)\//,
      "platform-control",
      "OpenCode modes, JS/TS plugins, custom tools and themes are executable or host-UI configuration; use Cognia hosting or a manual port",
    ],
    [
      /^(?:agents?|commands?|hooks|rules|policies|extensions|prompts|themes|output-styles|plugins?)\//,
      "platform-control",
      "OpenCode reads these directories from .opencode/ only",
    ],
    [
      /^(?:AGENTS|CLAUDE)\.md$/,
      "rules",
      "Always-on instruction files have no Cognia plugin equivalent",
    ],
  ],
}

/** Another host's runtime directories found in a bundle: never silently carried along. */
const FOREIGN_SURFACES: ReadonlyArray<[RegExp, string, string]> = [
  [
    /^\.opencode\/(?:agents?|commands?|modes?|plugins?|tools?|themes?)\//,
    "platform-control",
    "OpenCode runtime configuration has no meaning for this host",
  ],
]

/** Client namespaces a target reads (Agent Plugins §client-specific directories). */
const allowedNamespaces: Partial<Record<PlatformBundleTarget, string[]>> = {
  "agent-plugins": ["dev.openhands", "com.github.copilot"],
  copilot: ["com.github.copilot"],
}

function inventory(
  files: Files,
  result: PlatformBundleProjection,
  target: PlatformBundleTarget,
  consumed: ReadonlySet<string> = new Set()
): void {
  for (const path of files.keys()) {
    if (path.startsWith("/") || path.split(/[\\/]/).includes("..") || path.includes("\\")) {
      block(result, "path", path, "Bundle paths must be relative canonical paths without traversal")
      continue
    }
    if (consumed.has(path) || path.startsWith(`${NORMALIZED}/`)) continue
    const surfaces = [
      ...UNMAPPED_SURFACES[target],
      ...(target === "opencode" ? [] : FOREIGN_SURFACES),
    ]
    let reported = false
    for (const [pattern, capability, message] of surfaces) {
      if (pattern.test(path)) {
        block(result, capability, path, message)
        reported = true
        break
      }
    }
    if (!reported && /^[a-z0-9-]+(?:\.[a-z0-9-]+)+\//.test(path)) {
      const namespace = path.split("/")[0]
      if (!(allowedNamespaces[target] ?? []).includes(namespace))
        block(
          result,
          "platform-control",
          path,
          `Client namespace ${namespace}/ has no documented Cognia mapping for this host`
        )
    }
  }
}

function checkFields(
  source: Json,
  allowed: string[],
  path: string,
  result: PlatformBundleProjection
): void {
  for (const field of Object.keys(source)) {
    if (!allowed.includes(field))
      block(result, field, `${path}.${field}`, "Field has no verified behavioral mapping")
  }
}

function validateApManifest(source: Json, path: string, result: PlatformBundleProjection): void {
  if (typeof source.name !== "string" || source.name.length > 64 || !AP_NAME.test(source.name))
    block(result, "name", `${path}.name`, "Name is invalid for the Agent Plugins manifest")
  for (const key of ["version", "description", "homepage", "repository", "license"]) {
    if (source[key] !== undefined && typeof source[key] !== "string")
      block(result, "metadata", `${path}.${key}`, "Portable manifest metadata must be a string")
  }
  if (
    source.keywords !== undefined &&
    (!Array.isArray(source.keywords) ||
      source.keywords.some((keyword) => typeof keyword !== "string"))
  )
    block(result, "metadata", `${path}.keywords`, "Portable keywords must be an array of strings")
  if (source.author !== undefined) {
    if (!object(source.author))
      block(result, "metadata", `${path}.author`, "Portable author must be an object")
    else {
      checkFields(source.author, ["name", "email", "url"], `${path}.author`, result)
      if (Object.values(source.author).some((value) => typeof value !== "string"))
        block(result, "metadata", `${path}.author`, "Portable author values must be strings")
    }
  }
  if (
    source.extensions !== undefined &&
    (!object(source.extensions) || Object.values(source.extensions).some((value) => !object(value)))
  )
    block(
      result,
      "extensions",
      `${path}.extensions`,
      "Portable extensions must map namespaces to objects"
    )
}

function apVersion(source: Json): string | undefined {
  return AGENT_PLUGINS_SCHEMA_VERSIONS.find(
    (version) => source.$schema === AP_PLUGIN_SCHEMA(version)
  )
}

/** Tool names and pre-approval are host contracts, not portable skill restrictions. */
function adaptSkillSemantics(
  files: Files,
  result: PlatformBundleProjection,
  target: PlatformBundleTarget | "pi",
  direction: "import" | "export",
  skillPaths = [...files.keys()].filter((path) => path === "SKILL.md" || path.endsWith("/SKILL.md"))
): void {
  const known = [
    "name",
    "description",
    "license",
    "compatibility",
    "metadata",
    "disable-model-invocation",
    "allowed-tools",
    "allowedTools",
  ]
  for (const path of skillPaths) {
    try {
      const text = result.files.get(path) ?? files.get(path)!
      const parsed = matter(text)
      const data: Json = { ...parsed.data }
      let changed = false
      if (direction === "import" && target === "kimi") {
        for (const alias of ["disableModelInvocation", "disable_model_invocation"]) {
          if (data[alias] === undefined) continue
          if (
            data["disable-model-invocation"] !== undefined &&
            data["disable-model-invocation"] !== data[alias]
          ) {
            block(result, "skill-invocation", path, "Conflicting Kimi invocation policy aliases")
          }
          data["disable-model-invocation"] = data[alias]
          delete data[alias]
          changed = true
        }
        if (data.type === "prompt" || data.type === "inline") {
          delete data.type
          changed = true
        }
      }
      if (direction === "import" && target === "devin") {
        if (data.triggers !== undefined) {
          const triggers = data.triggers
          if (
            Array.isArray(triggers) &&
            triggers.includes("user") &&
            triggers.every((entry) => entry === "user" || entry === "model")
          ) {
            data["disable-model-invocation"] = !triggers.includes("model")
            delete data.triggers
            changed = true
          } else
            block(
              result,
              "skill-invocation",
              path,
              "Devin model-only or custom triggers need an invocation adapter"
            )
        }
        if (data["argument-hint"] !== undefined) {
          warn(
            result,
            "skill-frontmatter",
            `${path}.argument-hint`,
            "argument-hint only labels the skill in the host UI and was not projected"
          )
          delete data["argument-hint"]
          changed = true
        }
      }
      for (const key of Object.keys(data)) {
        if (!known.includes(key))
          block(
            result,
            "skill-frontmatter",
            `${path}.${key}`,
            "Skill field has no verified cross-platform behavioral mapping"
          )
      }
      if (present(data["allowed-tools"]) || present(data.allowedTools)) {
        block(
          result,
          "skill-tools",
          path,
          "Tool identities and pre-approval differ by host; a tool and permission adapter is required"
        )
      }
      const manual = data["disable-model-invocation"]
      if (manual !== undefined && typeof manual !== "boolean")
        block(result, "skill-invocation", path, "disable-model-invocation must be a boolean")
      if (manual === true && (target === "opencode" || target === "agent-plugins")) {
        block(
          result,
          "skill-invocation",
          path,
          target === "opencode"
            ? "OpenCode ignores disable-model-invocation; manual-only activation cannot be preserved"
            : "Agent Plugins does not define a host-independent manual invocation policy"
        )
      }
      if (direction === "export" && target === "devin" && typeof manual === "boolean") {
        data.triggers = manual ? ["user"] : ["user", "model"]
        delete data["disable-model-invocation"]
        changed = true
      }
      const directoryName = path.split("/").at(-2)
      if (
        direction === "import" &&
        target === "opencode" &&
        directoryName &&
        data.name !== directoryName
      )
        block(result, "skill-name", path, "OpenCode skill names must match their directory")
      if (direction === "export") {
        if (
          typeof data.name !== "string" ||
          !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(data.name) ||
          data.name.length > 64
        )
          block(
            result,
            "skill-name",
            path,
            "Target skills require a lowercase identifier of at most 64 characters"
          )
        if (
          target !== "pi" &&
          target !== "devin" &&
          target !== "kimi" &&
          directoryName &&
          data.name !== directoryName
        )
          block(result, "skill-name", path, "Target skill name must match its parent directory")
        if (
          typeof data.description !== "string" ||
          !data.description.trim() ||
          data.description.length > 1024
        )
          block(
            result,
            "skill-description",
            path,
            "Target skills require a non-empty description of at most 1024 characters"
          )
      }
      if (changed) result.files.set(path, matter.stringify(parsed.content, data))
    } catch (error) {
      block(
        result,
        "skill-frontmatter",
        path,
        error instanceof Error ? error.message : String(error)
      )
    }
  }
  const roots = skillPaths.map((path) => path.slice(0, Math.max(0, path.lastIndexOf("/"))))
  const runtime =
    /\$(?:\{(?:COGNIA_PLUGIN_ROOT|CLAUDE_PLUGIN_ROOT|CLAUDE_PLUGIN_DATA|CLAUDE_PROJECT_DIR|CLAUDE_SKILL_DIR|CODEX_PLUGIN_ROOT|COPILOT_PLUGIN_ROOT|PLUGIN_ROOT|PLUGIN_DATA|CURSOR_PLUGIN_ROOT|KIMI_PLUGIN_ROOT|KIMI_SKILL_DIR|extensionPath|workspacePath)\}|(?:CLAUDE_PLUGIN_ROOT|PLUGIN_ROOT|PLUGIN_DATA|KIMI_SKILL_DIR)\b)/
  for (const [path, text] of files) {
    const resource = roots.some((root) =>
      root
        ? path.startsWith(`${root}/`)
        : path === "SKILL.md" || /^(?:scripts|references|assets)\//.test(path)
    )
    if (resource && runtime.test(text))
      block(
        result,
        "skill-runtime",
        path,
        "Host runtime variables in skill resources need a component-specific binding; bytes were preserved but execution cannot be promised"
      )
    if (direction === "export" && target === "opencode" && path.startsWith("skills/")) {
      const outsideSkillTree = [...text.matchAll(/(?:\.\.\/)+/g)].some(
        (match) => match[0].split("../").length - 1 >= path.split("/").length - 1
      )
      if (outsideSkillTree)
        block(
          result,
          "skill-resources",
          path,
          "Moving skills into .opencode changes relative references outside the skills tree; dependency relocation is required"
        )
    }
  }
}

/** Shared skill validation for targets projected outside this module (Pi). */
export function checkSkillSemantics(
  files: Files,
  target: PlatformBundleTarget | "pi",
  direction: "import" | "export",
  skillPaths?: string[]
): Pick<PlatformBundleProjection, "blocking" | "warnings" | "files"> {
  const result = emptyProjection(files)
  adaptSkillSemantics(files, result, target, direction, skillPaths)
  return result
}

/**
 * Canonicalize one host's MCP servers into Claude `.mcp.json` server objects
 * (`${CLAUDE_PLUGIN_ROOT}` tokens). Returns the servers plus any reported issue.
 */
function mcpServers(
  documents: Array<{ path: string; value: Json }>,
  target: PlatformBundleTarget,
  result: PlatformBundleProjection,
  version?: string
): Json {
  const output: Json = {}
  for (const document of documents) {
    if (target === "agent-plugins") {
      checkFields(document.value, ["$schema", "mcpServers"], document.path, result)
      if (!version || document.value.$schema !== AP_MCP_SCHEMA(version))
        block(
          result,
          "schema",
          `${document.path}.$schema`,
          "mcp.json must declare the Agent Plugins MCP schema of the same version as plugin.json"
        )
    } else if (target !== "opencode")
      checkFields(document.value, ["$schema", "mcpServers"], document.path, result)
    const servers =
      target === "opencode" ? (document.value.mcp ?? {}) : (document.value.mcpServers ?? {})
    if (!object(servers)) throw new Error(`${document.path} servers must be an object`)
    for (const [name, value] of Object.entries(servers)) {
      if (!object(value)) throw new Error(`MCP server ${name} must be an object`)
      let server: Json = { ...value }
      const location = `${document.path}.${name}`
      if (target === "opencode") {
        const converted = openCodeServer(name, server, location, result)
        if (!converted) continue
        server = converted
      }
      const type = server.type ?? (server.command ? "stdio" : "http")
      if (
        target === "agent-plugins" &&
        !["stdio", "streamable-http", "sse"].includes(String(server.type))
      ) {
        block(result, "mcp", `mcpServers.${name}.type`, "Portable MCP transport must be explicit")
      }
      checkFields(
        server,
        type === "stdio" ? ["type", "command", "args", "env", "cwd"] : ["type", "url", "headers"],
        `mcpServers.${name}`,
        result
      )
      if (type === "stdio") {
        if (typeof server.command !== "string" || !server.command.trim())
          throw new Error(`MCP server ${name} requires a command`)
        if (
          server.args !== undefined &&
          (!Array.isArray(server.args) || server.args.some((arg) => typeof arg !== "string"))
        )
          throw new Error(`MCP server ${name} args must be strings`)
      } else if (
        !["http", "streamable-http", "sse"].includes(String(type)) ||
        typeof server.url !== "string" ||
        !server.url.trim()
      ) {
        throw new Error(`Unsupported MCP transport or URL: ${name}`)
      }
      for (const key of ["env", "headers"]) {
        const record = server[key]
        if (
          record !== undefined &&
          (!object(record) || Object.values(record).some((item) => typeof item !== "string"))
        )
          throw new Error(`MCP server ${name} ${key} must contain strings`)
      }
      const serialized = JSON.stringify(server)
      if (/\$\{(?:[A-Z]+_)?PLUGIN_DATA\}/.test(serialized))
        block(
          result,
          "runtime-data",
          `mcpServers.${name}`,
          "Persistent plugin data lifecycle needs a verified binding"
        )
      if (target === "agent-plugins" || target === "copilot") {
        // Agent Plugins expands ${PLUGIN_ROOT} only in stdio args, env values and cwd.
        if (typeof server.command === "string" && server.command.includes("${"))
          block(
            result,
            "mcp",
            `mcpServers.${name}.command`,
            "Agent Plugins never expands variables in command; use a bare name or a ./-relative path"
          )
        if (type !== "stdio" && serialized.includes("${PLUGIN_ROOT}"))
          block(
            result,
            "mcp",
            `mcpServers.${name}`,
            "Agent Plugins passes remote server values through literally; ${PLUGIN_ROOT} would not expand there"
          )
        if (typeof server.command === "string" && server.command.startsWith("./"))
          server.command = `\${PLUGIN_ROOT}/${server.command.slice(2)}`
        if (type === "stdio" && server.cwd === undefined && target === "agent-plugins")
          server.cwd = "${PLUGIN_ROOT}"
        if (server.cwd !== undefined) {
          if (
            typeof server.cwd !== "string" ||
            !/^(?:\.\/|\$\{PLUGIN_ROOT\}(?:\/|$)|\$\{PLUGIN_DATA\}(?:\/|$))/.test(server.cwd)
          )
            block(
              result,
              "mcp",
              `mcpServers.${name}.cwd`,
              "Agent Plugins cwd must start with ./, ${PLUGIN_ROOT} or ${PLUGIN_DATA}"
            )
          else if (server.cwd.startsWith("./"))
            server.cwd = `\${PLUGIN_ROOT}/${server.cwd.slice(2)}`
        }
        if (
          object(server.env) &&
          ["PLUGIN_ROOT", "PLUGIN_DATA"].some((key) => key in (server.env as Json))
        )
          block(
            result,
            "mcp",
            `mcpServers.${name}.env`,
            "Portable MCP reserved runtime variables cannot be overridden"
          )
      }
      if (target === "cursor" && /\$\{PLUGIN_(?:ROOT|DATA)\}/.test(serialized))
        block(
          result,
          "mcp",
          `mcpServers.${name}`,
          "Cursor does not expand ${PLUGIN_ROOT} or ${PLUGIN_DATA}; the server would receive the literal text"
        )
      const tokens =
        target === "cursor"
          ? ["${CURSOR_PLUGIN_ROOT}"]
          : target === "copilot"
            ? ["${PLUGIN_ROOT}", "${COPILOT_PLUGIN_ROOT}"]
            : target === "devin"
              ? ["${PLUGIN_ROOT}"]
              : target === "agent-plugins"
                ? ["${PLUGIN_ROOT}"]
                : []
      server = replaceRootTokens(server, tokens, [], "${CLAUDE_PLUGIN_ROOT}") as Json
      if (output[name] !== undefined)
        block(result, "mcp", location, "Duplicate MCP server name across declarations")
      output[name] = { ...server, type: type === "streamable-http" ? "http" : type }
    }
  }
  return output
}

function openCodeServer(
  name: string,
  server: Json,
  location: string,
  result: PlatformBundleProjection
): Json | null {
  const allowed =
    server.type === "remote"
      ? ["type", "url", "enabled", "headers", "oauth", "timeout"]
      : ["type", "command", "cwd", "environment", "enabled", "timeout"]
  checkFields(server, allowed, `mcp.${name}`, result)
  if (server.enabled === false)
    block(result, "mcp", `mcp.${name}.enabled`, "Disabled-server state cannot be discarded")
  if (server.timeout !== undefined && server.timeout !== 5000)
    warn(
      result,
      "mcp",
      `mcp.${name}.timeout`,
      "OpenCode's tool-fetch timeout is not projected; Cognia applies its own MCP startup timeout"
    )
  const text = JSON.stringify(server)
  if (/\{file:[^}]+\}/.test(text)) {
    block(
      result,
      "mcp",
      location,
      "OpenCode {file:path} substitution reads files at load time; Cognia has no equivalent"
    )
    return null
  }
  const substitute = (value: unknown): unknown =>
    typeof value === "string" ? value.replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, "${$1}") : value
  if (server.type === "remote") {
    block(
      result,
      "mcp",
      location,
      "OpenCode remote servers fall back from streamable HTTP to SSE and negotiate OAuth automatically; Cognia cannot reproduce that negotiation"
    )
    return null
  }
  if (server.type !== "local" || !Array.isArray(server.command) || server.command.length === 0)
    throw new Error(`Invalid OpenCode MCP server: ${name}`)
  if (typeof server.cwd === "string" && !server.cwd.startsWith("/"))
    warn(
      result,
      "mcp",
      `mcp.${name}.cwd`,
      "OpenCode resolves a relative cwd from the project directory; verify the working directory after import"
    )
  const environment = object(server.environment)
    ? Object.fromEntries(
        Object.entries(server.environment).map(([key, value]) => [key, substitute(value)])
      )
    : undefined
  return {
    command: substitute(server.command[0]),
    args: server.command.slice(1).map(substitute),
    ...(environment ? { env: environment } : {}),
    ...(typeof server.cwd === "string" ? { cwd: server.cwd } : {}),
  }
}

function mcpDeclarations(
  files: Files,
  declared: unknown,
  conventional: string[],
  mode: "merge" | "replace",
  result: PlatformBundleProjection
): Array<{ path: string; value: Json }> {
  const documents: Array<{ path: string; value: Json }> = []
  const items = Array.isArray(declared) ? declared : declared === undefined ? [] : [declared]
  for (const item of items) {
    if (typeof item === "string") {
      const path = stripDot(item)
      if (!files.has(path)) throw new Error(`MCP configuration not found: ${path}`)
      documents.push({ path, value: read(files, path) })
    } else if (object(item)) {
      documents.push({
        path: "mcpServers",
        value: "mcpServers" in item ? item : { mcpServers: item },
      })
    } else {
      block(
        result,
        "mcp",
        "mcpServers",
        "This MCP declaration shape is not documented for the host"
      )
    }
  }
  if (documents.length === 0 || mode === "merge")
    for (const path of conventional)
      if (files.has(path) && !documents.some((document) => document.path === path))
        documents.push({ path, value: read(files, path) })
  return documents
}

/** Agents: re-check frontmatter and write a canonical Claude agent file. */
function normalizeAgent(args: {
  files: Files
  path: string
  id: string
  allowed: string[]
  label: string
  result: PlatformBundleProjection
  agents: string[]
  rewrite?: (data: Json) => string | null
}): void {
  const { path, result } = args
  let parsed: matter.GrayMatterFile<string>
  try {
    parsed = matter(args.files.get(path) ?? "")
  } catch (error) {
    block(result, "agents", path, error instanceof Error ? error.message : String(error))
    return
  }
  const data: Json = { ...parsed.data }
  const veto = args.rewrite?.(data)
  if (veto) {
    block(result, "agents", path, veto)
    return
  }
  const unsupported = Object.keys(data).filter((key) => !args.allowed.includes(key))
  if (unsupported.length) {
    block(
      result,
      "agents",
      path,
      `${args.label} agent fields have no exact Cognia equivalent: ${unsupported.join(", ")}`
    )
    return
  }
  if (typeof data.name === "string" && data.name !== args.id)
    warn(
      result,
      "agents",
      path,
      `${args.label} display name "${data.name}" is not projected; the agent id is "${args.id}"`
    )
  delete data.name
  const target = `${NORMALIZED}/agents/${args.id}.md`
  if (result.files.has(target)) {
    block(result, "agents", path, `Duplicate agent id ${args.id}`)
    return
  }
  result.files.set(target, matter.stringify(parsed.content, data))
  result.transient.add(target)
  args.agents.push(`./${target}`)
}

function normalizeCommand(args: {
  files: Files
  path: string
  name: string
  allowed: string[]
  label: string
  result: PlatformBundleProjection
  commands: string[]
}): void {
  const { path, result } = args
  const text = args.files.get(path) ?? ""
  let parsed: matter.GrayMatterFile<string>
  try {
    parsed = path.endsWith(".txt")
      ? ({ content: text, data: {} } as matter.GrayMatterFile<string>)
      : matter(text)
  } catch (error) {
    block(result, "commands", path, error instanceof Error ? error.message : String(error))
    return
  }
  const unsupported = Object.keys(parsed.data).filter((key) => !args.allowed.includes(key))
  if (unsupported.length) {
    block(
      result,
      "commands",
      path,
      `${args.label} command fields have no exact Cognia equivalent: ${unsupported.join(", ")}`
    )
    return
  }
  if (/(^|\s)@[\w./-]*[./][\w./-]+/.test(parsed.content))
    warn(
      result,
      "commands",
      path,
      `${args.label} inlines @file references when the command runs; the converted skill keeps them as literal text`
    )
  const target = `${NORMALIZED}/commands/${args.name}.md`
  if (result.files.has(target)) {
    block(result, "commands", path, `Duplicate command ${args.name}`)
    return
  }
  result.files.set(target, matter.stringify(parsed.content, { ...parsed.data, name: args.name }))
  result.transient.add(target)
  args.commands.push(`./${target}`)
}

function normalizeHooks(args: {
  files: Files
  path: string
  dialect: HookDialect
  tokens: string[]
  result: PlatformBundleProjection
  hooks: string[]
}): void {
  const value = read(args.files, args.path)
  const canonical = hookDocumentToCanonical({
    value,
    path: args.path,
    dialect: args.dialect,
    sink: args.result,
  })
  const target = `${NORMALIZED}/hooks/${args.hooks.length}.json`
  save(
    args.result.files,
    target,
    replaceRootTokens(canonical, args.tokens, [], "${CLAUDE_PLUGIN_ROOT}") as Json
  )
  args.result.transient.add(target)
  args.hooks.push(`./${target}`)
}

function filesIn(files: Files, dir: string, pattern: RegExp, recursive = false): string[] {
  const prefix = `${dir}/`
  return [...files.keys()]
    .filter(
      (path) =>
        path.startsWith(prefix) &&
        pattern.test(path) &&
        (recursive || !path.slice(prefix.length).includes("/"))
    )
    .sort()
}

function immediateSkills(files: Files, root: string): string[] {
  return [...files.keys()]
    .filter((path) => new RegExp(`^${root.replace(/[.]/g, "\\.")}/[^/]+/SKILL\\.md$`).test(path))
    .sort()
}

function nestedSkills(files: Files, root: string): string[] {
  if (files.has(`${root}/SKILL.md`)) return [`${root}/SKILL.md`]
  return [...files.keys()]
    .filter((path) => path.startsWith(`${root}/`) && path.endsWith("/SKILL.md"))
    .sort()
}

/** Normalize only proven declarative contributions for the canonical Claude reader. */
export function normalizePlatformBundle(
  files: Files,
  target: PlatformBundleTarget
): PlatformBundleProjection {
  const result = emptyProjection(files)
  const path = manifestPath(files, target)
  const consumed = new Set<string>()
  try {
    if (!files.has(path)) throw new Error(`Manifest not found: ${path}`)
    const source = read(files, path)
    if (target === "copilot" && path === "plugin.json" && typeof source.$schema === "string") {
      if (!apVersion(source)) {
        block(
          result,
          "schema",
          `${path}.$schema`,
          "Copilot CLI rejects plugins that declare an unsupported Agent Plugins version"
        )
        return result
      }
      return normalizePlatformBundle(files, "agent-plugins")
    }
    const manifest: Json = Object.fromEntries(
      METADATA.filter((key) => source[key] !== undefined).map((key) => [key, source[key]])
    )
    const agents: string[] = []
    const commands: string[] = []
    const hooks: string[] = []
    let skills: string[] = []
    let documents: Array<{ path: string; value: Json }> = []
    let version: string | undefined
    let name: unknown = source.name

    if (target === "agent-plugins") {
      version = apVersion(source)
      if (!version)
        block(
          result,
          "schema",
          `${path}.$schema`,
          `Unsupported Agent Plugins version; supported: ${AGENT_PLUGINS_SCHEMA_VERSIONS.join(", ")}`
        )
      validateApManifest(source, path, result)
      for (const key of Object.keys(source))
        if (![...METADATA, "$schema", "extensions"].includes(key))
          warn(
            result,
            key,
            `${path}.${key}`,
            "Agent Plugins hosts report and ignore unknown top-level fields; it was not projected"
          )
      if (object(source.extensions))
        for (const [namespace, value] of Object.entries(source.extensions))
          if (present(value))
            block(
              result,
              "extensions",
              `${path}.extensions.${namespace}`,
              "Client extension data has client-defined semantics with no Cognia mapping"
            )
      skills = immediateSkills(files, "skills")
      for (const nested of nestedSkills(files, "skills").filter((entry) => !skills.includes(entry)))
        warn(
          result,
          "skills",
          nested,
          "Agent Plugins loads only immediate skills/<dir>/SKILL.md children; this skill is not loaded"
        )
      if (files.has("SKILL.md"))
        warn(
          result,
          "skills",
          "SKILL.md",
          "Agent Plugins has no root SKILL.md fallback; it is not loaded"
        )
      if (files.has("mcp.json")) documents = [{ path: "mcp.json", value: read(files, "mcp.json") }]
      // Client namespaces: OpenHands (Claude-format hooks) and Copilot.
      for (const agentPath of filesIn(files, "dev.openhands/agents", /\.md$/i)) {
        consumed.add(agentPath)
        normalizeAgent({
          files,
          path: agentPath,
          id: agentPath.split("/").pop()!.replace(/\.md$/i, ""),
          allowed: ["name", "description"],
          label: "OpenHands",
          result,
          agents,
        })
      }
      for (const agentPath of filesIn(files, "com.github.copilot/agents", /\.md$/i)) {
        consumed.add(agentPath)
        normalizeAgent({
          files,
          path: agentPath,
          id: agentPath
            .split("/")
            .pop()!
            .replace(/(?:\.agent)?\.md$/i, ""),
          allowed: ["name", "description"],
          label: "Copilot",
          result,
          agents,
        })
      }
      for (const namespace of ["dev.openhands", "com.github.copilot"])
        for (const commandPath of filesIn(files, `${namespace}/commands`, /\.md$/i)) {
          consumed.add(commandPath)
          normalizeCommand({
            files,
            path: commandPath,
            name: commandPath.split("/").pop()!.replace(/\.md$/i, ""),
            allowed: ["description", "allowed-tools", "disable-model-invocation"],
            label: namespace,
            result,
            commands,
          })
        }
      if (files.has("dev.openhands/hooks/hooks.json")) {
        consumed.add("dev.openhands/hooks/hooks.json")
        normalizeHooks({
          files,
          path: "dev.openhands/hooks/hooks.json",
          dialect: HOOK_DIALECTS.openhands,
          tokens: ["${PLUGIN_ROOT}"],
          result,
          hooks,
        })
      }
      for (const [blocked, capability, message] of [
        [
          "com.github.copilot/hooks/hooks.json",
          "hooks",
          "Copilot hook files use Copilot's own contract (version 1, flat bash/powershell entries, preToolUse fail-closed on non-zero exit); no exact Cognia mapping exists",
        ],
        [
          "com.github.copilot/lsp.json",
          "lspServers",
          "LSP servers need a language-server host; Cognia has no plugin LSP contribution",
        ],
      ] as const)
        if (files.has(blocked)) {
          consumed.add(blocked)
          block(result, capability, blocked, message)
        }
      for (const rule of filesIn(files, "com.github.copilot/rules", /./, true)) {
        consumed.add(rule)
        block(
          result,
          "rules",
          rule,
          "Copilot rules are always-on or conditional instructions; Cognia plugins have no rule contribution"
        )
      }
      // Remaining files inside the two known namespaces are resources of the
      // components above (scripts referenced by hooks, agent assets).
      for (const file of files.keys())
        if (file.startsWith("dev.openhands/") || file.startsWith("com.github.copilot/"))
          consumed.add(file)
    } else if (target === "copilot") {
      if (typeof source.name !== "string" || !/^[A-Za-z0-9-]{1,64}$/.test(source.name))
        warn(
          result,
          "name",
          `${path}.name`,
          "Copilot legacy names allow letters, digits and hyphens (max 64); the host may refuse this plugin"
        )
      for (const key of Object.keys(source)) {
        if ([...METADATA, "agents", "skills", "commands", "mcpServers"].includes(key)) continue
        if (key === "category" || key === "tags")
          warn(result, key, `${path}.${key}`, "Marketplace presentation metadata was not projected")
        else if (key === "hooks")
          block(
            result,
            "hooks",
            `${path}.hooks`,
            "Copilot hook configuration uses Copilot's own contract; no exact Cognia mapping exists"
          )
        else if (key === "lspServers")
          block(
            result,
            "lspServers",
            `${path}.lspServers`,
            "LSP servers need a language-server host"
          )
        else if (key === "extensions")
          block(
            result,
            "extensions",
            `${path}.extensions`,
            "Copilot extension directories run host code"
          )
        else
          warn(
            result,
            key,
            `${path}.${key}`,
            "Copilot reports and ignores unknown manifest fields; it was not projected"
          )
      }
      const skillRoots = source.skills !== undefined ? pathsOf(source.skills) : ["skills"]
      skills = skillRoots.flatMap((root) =>
        root.endsWith(".md") ? [root] : nestedSkills(files, root)
      )
      if (source.skills === undefined && skills.length === 0 && files.has("SKILL.md"))
        skills = ["SKILL.md"]
      for (const root of source.agents !== undefined ? pathsOf(source.agents) : ["agents"])
        for (const agentPath of filesIn(files, root, /\.agent\.md$/i, true)) {
          consumed.add(agentPath)
          normalizeAgent({
            files,
            path: agentPath,
            id: agentPath
              .split("/")
              .pop()!
              .replace(/\.agent\.md$/i, ""),
            allowed: ["name", "description"],
            label: "Copilot",
            result,
            agents,
          })
        }
      for (const root of pathsOf(source.commands))
        for (const commandPath of filesIn(files, root, /\.md$/i, true)) {
          consumed.add(commandPath)
          normalizeCommand({
            files,
            path: commandPath,
            name: commandPath.split("/").pop()!.replace(/\.md$/i, ""),
            allowed: ["description", "allowed-tools", "disable-model-invocation"],
            label: "Copilot",
            result,
            commands,
          })
        }
      documents = mcpDeclarations(
        files,
        source.mcpServers,
        [".mcp.json", ".github/mcp.json"],
        "replace",
        result
      )
    } else if (target === "cursor") {
      if (
        typeof source.name !== "string" ||
        !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(source.name)
      )
        warn(
          result,
          "name",
          `${path}.name`,
          "Cursor plugin names must be lowercase kebab-case; the host may refuse this plugin"
        )
      if (object(source.author))
        checkFields(source.author, ["name", "email"], `${path}.author`, result)
      for (const key of Object.keys(source))
        if (
          ![
            ...METADATA,
            "logo",
            "rules",
            "agents",
            "skills",
            "commands",
            "hooks",
            "mcpServers",
            "variables",
          ].includes(key)
        )
          block(result, key, `${path}.${key}`, "Field has no verified behavioral mapping")
      if (typeof source.logo === "string") manifest.icon = source.logo
      for (const rule of source.rules !== undefined ? pathsOf(source.rules) : ["rules"])
        for (const rulePath of rule.match(/\.(?:md|mdc|markdown)$/)
          ? [rule].filter((entry) => files.has(entry))
          : filesIn(files, rule, /\.(?:md|mdc|markdown)$/i, true)) {
          consumed.add(rulePath)
          block(result, "rules", rulePath, UNMAPPED_SURFACES.cursor[0][2])
        }
      const skillRoots = source.skills !== undefined ? pathsOf(source.skills) : ["skills"]
      skills = skillRoots.flatMap((root) =>
        root.endsWith(".md")
          ? [root]
          : source.skills !== undefined
            ? nestedSkills(files, root)
            : immediateSkills(files, root)
      )
      if (source.skills === undefined && skills.length === 0 && files.has("SKILL.md"))
        skills = ["SKILL.md"]
      for (const root of source.agents !== undefined ? pathsOf(source.agents) : ["agents"])
        for (const agentPath of root.match(/\.(?:md|mdc|markdown)$/)
          ? [root]
          : filesIn(files, root, /\.(?:md|mdc|markdown)$/i, true)) {
          consumed.add(agentPath)
          normalizeAgent({
            files,
            path: agentPath,
            id: agentPath
              .split("/")
              .pop()!
              .replace(/\.(?:md|mdc|markdown)$/i, ""),
            allowed: ["name", "description"],
            label: "Cursor",
            result,
            agents,
          })
        }
      for (const root of source.commands !== undefined ? pathsOf(source.commands) : ["commands"])
        for (const commandPath of root.match(/\.(?:md|mdc|markdown|txt)$/)
          ? [root]
          : filesIn(files, root, /\.(?:md|mdc|markdown|txt)$/i, true)) {
          consumed.add(commandPath)
          normalizeCommand({
            files,
            path: commandPath,
            name: commandPath
              .split("/")
              .pop()!
              .replace(/\.(?:md|mdc|markdown|txt)$/i, ""),
            allowed: ["description"],
            label: "Cursor",
            result,
            commands,
          })
        }
      if (object(source.hooks)) {
        const inline = hookDocumentToCanonical({
          value: source.hooks,
          path: `${path}.hooks`,
          dialect: HOOK_DIALECTS.cursor,
          sink: result,
        })
        const hookPath = `${NORMALIZED}/hooks/inline.json`
        save(
          result.files,
          hookPath,
          replaceRootTokens(inline, ["${CURSOR_PLUGIN_ROOT}"], [], "${CLAUDE_PLUGIN_ROOT}") as Json
        )
        result.transient.add(hookPath)
        hooks.push(`./${hookPath}`)
      } else {
        const hookPath =
          typeof source.hooks === "string" ? stripDot(source.hooks) : "hooks/hooks.json"
        if (typeof source.hooks === "string" && !files.has(hookPath))
          throw new Error(`Hooks configuration not found: ${hookPath}`)
        if (files.has(hookPath)) {
          consumed.add(hookPath)
          normalizeHooks({
            files,
            path: hookPath,
            dialect: HOOK_DIALECTS.cursor,
            tokens: ["${CURSOR_PLUGIN_ROOT}"],
            result,
            hooks,
          })
        }
      }
      documents = mcpDeclarations(files, source.mcpServers, ["mcp.json"], "replace", result)
      if (source.variables !== undefined) {
        const declarations = cursorVariables(source.variables, `${path}.variables`, result)
        result.settings = { declarations, servers: {} }
      }
    } else if (target === "kimi") {
      if (typeof source.name !== "string" || !/^[a-z0-9-]+$/.test(source.name))
        block(
          result,
          "name",
          `${path}.name`,
          "Kimi plugin names allow lowercase letters, digits and hyphens only"
        )
      if (
        typeof source.version !== "string" ||
        !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(source.version)
      )
        block(result, "version", `${path}.version`, "Kimi requires a semantic version")
      for (const key of Object.keys(source)) {
        if (["name", "version", "description", "config_file"].includes(key)) continue
        if (key === "tools") {
          if (!Array.isArray(source.tools))
            block(result, "tools", `${path}.tools`, "Kimi tools must be an array")
          else if (source.tools.length)
            block(
              result,
              "tools",
              `${path}.tools`,
              "Kimi tools receive their parameters as one JSON object on stdin (cwd = plugin directory, 120 s timeout) and return stdout; Cognia cliTools map arguments to argv flags, so no exact mapping exists"
            )
        } else if (key === "inject") {
          if (present(source.inject))
            block(
              result,
              "inject",
              `${path}.inject`,
              "Kimi injects the host's LLM API key and base URL into the plugin config; Cognia never copies credentials into plugins"
            )
        } else
          warn(
            result,
            key,
            `${path}.${key}`,
            "Kimi ignores fields outside its plugin schema; it was not projected"
          )
      }
      if (source.config_file !== undefined && !present(source.inject))
        warn(
          result,
          "config_file",
          `${path}.config_file`,
          "config_file only receives injected credentials; without inject it has no behavior"
        )
      for (const key of ["homepage", "repository", "license", "keywords", "author"])
        delete manifest[key]
      if (files.has("SKILL.md")) {
        skills = ["SKILL.md"]
        const configFile =
          typeof source.config_file === "string" ? stripDot(source.config_file) : undefined
        result.rootSkillResources = [...files.keys()].filter(
          (file) =>
            file !== "SKILL.md" &&
            file !== path &&
            file !== configFile &&
            !/(^|\/)\.env(?:\.|$)/.test(file) &&
            !file.startsWith(".claude-plugin/")
        )
      }
      for (const nested of nestedSkills(files, "skills"))
        block(
          result,
          "skills",
          nested,
          "Kimi treats only the plugin directory's root SKILL.md as a skill; this skill would never load"
        )
    } else if (target === "devin") {
      if (typeof source.name !== "string" || !/^[a-z0-9]+(?:[-.][a-z0-9]+)*$/.test(source.name))
        warn(
          result,
          "name",
          `${path}.name`,
          "Devin plugin names are lowercase alphanumerics separated by single - or .; the host may refuse this plugin"
        )
      for (const key of Object.keys(source)) {
        if ([...METADATA, "skills", "mcpServers"].includes(key)) continue
        if (["requiredPlugins", "optionalPlugins", "forbiddenPlugins"].includes(key)) {
          if (present(source[key]))
            block(
              result,
              key,
              `${path}.${key}`,
              "Plugin dependency and governance lists install or forbid other plugins; Cognia has no equivalent"
            )
        } else if (key === "hooks")
          block(result, "hooks", `${path}.hooks`, UNMAPPED_SURFACES.devin[3][2])
        else block(result, key, `${path}.${key}`, "Field has no verified behavioral mapping")
      }
      if (Array.isArray(source.skills) && source.skills.length === 0) skills = []
      else {
        const roots = source.skills !== undefined ? pathsOf(source.skills) : ["skills"]
        for (const root of typeof source.skills === "string" || Array.isArray(source.skills)
          ? Array.isArray(source.skills)
            ? source.skills
            : [source.skills]
          : [])
          if (
            typeof root !== "string" ||
            root.startsWith("/") ||
            root.startsWith("~") ||
            root.split("/").includes("..")
          )
            block(result, "skills", `${path}.skills`, "Devin rejects absolute, ~ or .. skill paths")
        skills = roots.flatMap((root) =>
          root.endsWith(".md") ? [root] : nestedSkills(files, root)
        )
      }
      const declared = source.mcpServers
      if (object(declared) && Array.isArray(declared.paths)) {
        for (const key of Object.keys(declared))
          if (!["paths", "exclusive"].includes(key))
            block(
              result,
              "mcp",
              `${path}.mcpServers.${key}`,
              "Field has no verified behavioral mapping"
            )
        documents = mcpDeclarations(
          files,
          declared.paths,
          [".mcp.json"],
          declared.exclusive === true ? "replace" : "merge",
          result
        )
        // Devin skips root .mcp.json for an exclusive declaration; neutralize the
        // unread config so its raw values never reach an installed copy.
        if (declared.exclusive === true && files.has(".mcp.json")) {
          consumed.add(".mcp.json")
          result.files.set(".mcp.json", "{}\n")
        }
      } else if (object(declared)) {
        if (files.has(".mcp.json"))
          block(
            result,
            "mcp",
            `${path}.mcpServers`,
            "Devin does not document whether inline servers merge with .mcp.json"
          )
        documents = mcpDeclarations(files, declared, [], "replace", result)
      } else documents = mcpDeclarations(files, declared, [".mcp.json"], "merge", result)
    } else {
      // OpenCode
      name = "opencode-resource-bundle"
      checkFields(source, ["$schema", "mcp"], path, result)
      documents = [{ path, value: source }]
      skills = [".opencode/skills", ".opencode/skill"].flatMap((root) =>
        immediateSkills(files, root)
      )
      for (const dir of [".opencode/commands", ".opencode/command"])
        for (const commandPath of filesIn(files, dir, /\.md$/i, true)) {
          consumed.add(commandPath)
          normalizeCommand({
            files,
            path: commandPath,
            name: commandPath
              .slice(dir.length + 1)
              .replace(/\.md$/i, "")
              .replaceAll("/", "-"),
            allowed: ["description"],
            label: "OpenCode",
            result,
            commands,
          })
        }
      for (const dir of [".opencode/agents", ".opencode/agent"])
        for (const agentPath of filesIn(files, dir, /\.md$/i, true)) {
          consumed.add(agentPath)
          normalizeAgent({
            files,
            path: agentPath,
            id: agentPath.split("/").pop()!.replace(/\.md$/i, ""),
            allowed: ["description", "hidden", "color"],
            label: "OpenCode",
            result,
            agents,
            rewrite: (data) => {
              if (data.mode !== "subagent")
                return `OpenCode agent mode ${JSON.stringify(data.mode ?? "all")} also runs as a primary agent; only mode: subagent maps to a Cognia subagent`
              delete data.mode
              return null
            },
          })
        }
    }

    adaptSkillSemantics(files, result, target, "import", skills)
    if (typeof name !== "string" || !name.trim()) throw new Error(`${path}.name is required`)
    manifest.name = name
    const servers = target === "kimi" ? {} : mcpServers(documents, target, result, version)
    if (result.settings) result.settings.servers = servers
    // Installers overlay the original tree; deleting a raw config from this
    // map would leave credentials in the installed source. Replace it instead.
    result.files.set(path, "{}\n")
    for (const document of documents)
      if (files.has(document.path) && document.path !== CLAUDE_MANIFEST) {
        result.files.set(document.path, "{}\n")
        consumed.add(document.path)
      }
    if (Object.keys(servers).length) {
      const mcpPath =
        files.has(".mcp.json") && !documents.some((document) => document.path === ".mcp.json")
          ? `${NORMALIZED}/mcp.json`
          : ".mcp.json"
      save(result.files, mcpPath, { mcpServers: servers })
      if (!files.has(mcpPath)) result.transient.add(mcpPath)
      manifest.mcpServers = `./${mcpPath}`
    }
    manifest.agents = agents
    manifest.commands = commands
    manifest.hooks = hooks
    result.skills = skills
    save(result.files, CLAUDE_MANIFEST, manifest)
    if (!files.has(CLAUDE_MANIFEST)) result.transient.add(CLAUDE_MANIFEST)
    inventory(files, result, target, consumed)
    warn(
      result,
      "compatibility",
      path,
      "Declarative normalization only; native host execution has not been verified"
    )
  } catch (error) {
    block(result, "format", path, error instanceof Error ? error.message : String(error))
  }
  return result
}

function cursorVariables(
  value: unknown,
  path: string,
  result: PlatformBundleProjection
): PlatformInstallSetting[] {
  if (!object(value) || value.type !== "object" || !object(value.properties)) {
    block(
      result,
      "variables",
      path,
      "Cursor variables must be a JSON Schema object with properties"
    )
    return []
  }
  for (const key of Object.keys(value))
    if (!["type", "properties", "required", "$schema", "title", "description"].includes(key))
      block(
        result,
        "variables",
        `${path}.${key}`,
        "Variable schema keyword has no Cognia preset-field equivalent"
      )
  const declarations: PlatformInstallSetting[] = []
  for (const [envVar, raw] of Object.entries(value.properties)) {
    if (!object(raw) || (raw.type !== undefined && raw.type !== "string")) {
      block(
        result,
        "variables",
        `${path}.properties.${envVar}`,
        "Only string variables map to Cognia preset fields"
      )
      continue
    }
    for (const key of Object.keys(raw))
      if (!["type", "title", "description"].includes(key))
        block(
          result,
          "variables",
          `${path}.properties.${envVar}.${key}`,
          "Variable schema keyword has no Cognia preset-field equivalent"
        )
    declarations.push({
      envVar,
      name: typeof raw.title === "string" && raw.title.trim() ? raw.title : envVar,
      ...(typeof raw.description === "string" ? { description: raw.description } : {}),
      // Cursor stores variable values in its dashboard, never in the plugin.
      sensitive: true,
    })
  }
  return declarations
}

/** Project a validated Claude-shaped bundle; never port its executable lifecycle. */
export function projectPlatformBundle(
  files: Files,
  target: PlatformBundleTarget,
  options: { variables?: PlatformInstallSetting[] } = {}
): PlatformBundleProjection {
  const result = emptyProjection(files)
  const consumed = new Set<string>()
  try {
    if (!files.has(CLAUDE_MANIFEST))
      throw new Error("A validated Claude bundle manifest is required")
    const source = read(files, CLAUDE_MANIFEST)
    checkFields(
      source,
      [...METADATA, "displayName", "skills", "agents", "mcpServers"],
      CLAUDE_MANIFEST,
      result
    )
    const metadata = Object.fromEntries(
      METADATA.filter((key) => source[key] !== undefined).map((key) => [key, source[key]])
    )
    if (["agent-plugins", "copilot"].includes(target))
      validateApManifest(metadata, PLATFORM_BUNDLE_PROFILES[target].manifest, result)
    if (
      target === "kimi" &&
      (typeof metadata.name !== "string" || !/^[a-z0-9-]+$/.test(metadata.name))
    )
      block(
        result,
        "name",
        "plugin.json.name",
        "Kimi plugin names allow lowercase letters, digits and hyphens only"
      )
    if (
      ["agent-plugins", "copilot", "opencode", "kimi"].includes(target) &&
      source.skills !== undefined
    ) {
      const roots = Array.isArray(source.skills) ? source.skills : [source.skills]
      if (roots.length !== 1 || !["skills", "./skills", "./skills/"].includes(String(roots[0])))
        block(
          result,
          "skills",
          "skills",
          "This target uses fixed skill locations; custom skill roots require resource relocation"
        )
    }
    adaptSkillSemantics(files, result, target, "export")
    // The Claude export declares MCP as a path or an inline map; any other shape is invalid input.
    const declared = source.mcpServers
    let documents: Array<{ path: string; value: Json }> = []
    if (typeof declared === "string") {
      const mcpPath = stripDot(declared)
      if (!files.has(mcpPath)) throw new Error(`MCP configuration not found: ${mcpPath}`)
      documents = [{ path: mcpPath, value: read(files, mcpPath) }]
    } else if (object(declared))
      documents = [
        {
          path: "mcpServers",
          value: "mcpServers" in declared ? declared : { mcpServers: declared },
        },
      ]
    else if (declared !== undefined)
      block(
        result,
        "mcp",
        "mcpServers",
        "This MCP declaration shape requires a platform-specific merge adapter"
      )
    else if (files.has(".mcp.json"))
      documents = [{ path: ".mcp.json", value: read(files, ".mcp.json") }]
    const servers = mcpServers(documents, "devin", result)
    result.files.delete(CLAUDE_MANIFEST)
    result.files.delete(".mcp.json")

    // Agents and hooks the Claude exporter wrote, re-homed per target.
    const agentFiles = [...files.keys()].filter((path) => /^agents\/[^/]+\.md$/.test(path))
    const hooksText = files.get("hooks/hooks.json")
    const projectAgents = (dir: string, suffix: string, allowed: string[], label: string) => {
      for (const agentPath of agentFiles) {
        consumed.add(agentPath)
        result.files.delete(agentPath)
        const id = agentPath.slice("agents/".length, -".md".length)
        const parsed = matter(files.get(agentPath) ?? "")
        const unsupported = Object.keys(parsed.data).filter((key) => !allowed.includes(key))
        if (unsupported.length) {
          block(
            result,
            "subagent",
            `subagents.${id}`,
            `${label} agents have no exact equivalent for: ${unsupported.join(", ")}`
          )
          continue
        }
        result.files.set(`${dir}/${id}${suffix}`, files.get(agentPath)!)
      }
    }
    const projectHooks = (path: string, dialect: HookDialect, token: string) => {
      if (hooksText === undefined) return
      consumed.add("hooks/hooks.json")
      result.files.delete("hooks/hooks.json")
      const document = JSON.parse(hooksText) as { hooks?: HooksConfig }
      const projected = canonicalHooksToDialect({
        hooks: document.hooks ?? {},
        dialect,
        sink: result,
        path,
      })
      if (projected)
        save(
          result.files,
          path,
          replaceRootTokens(projected, ["${CLAUDE_PLUGIN_ROOT}"], [], token) as Json
        )
    }

    if (target === "opencode") {
      warn(
        result,
        "metadata",
        "opencode.json",
        "OpenCode resource configuration has no native plugin identity metadata; imported identity will be generated"
      )
      const mcp: Json = {}
      for (const [name, value] of Object.entries(servers)) {
        const server = value as Json
        if (server.type !== "stdio" || JSON.stringify(server).includes("${")) {
          block(
            result,
            "mcp",
            `mcpServers.${name}`,
            "OpenCode export requires a local command without plugin-root paths or unresolved variables (OpenCode has no plugin root)"
          )
          continue
        }
        mcp[name] = {
          type: "local",
          command: [server.command, ...((server.args as string[]) ?? [])],
          ...(server.env ? { environment: server.env } : {}),
          ...(typeof server.cwd === "string" ? { cwd: server.cwd } : {}),
        }
      }
      for (const [path, text] of Array.from(result.files))
        if (path.startsWith("skills/")) {
          result.files.set(`.opencode/${path}`, text)
          result.files.delete(path)
        }
      for (const agentPath of agentFiles) {
        consumed.add(agentPath)
        result.files.delete(agentPath)
        const id = agentPath.slice("agents/".length, -".md".length)
        const parsed = matter(files.get(agentPath) ?? "")
        const unsupported = Object.keys(parsed.data).filter(
          (key) => !["name", "description"].includes(key)
        )
        if (unsupported.length) {
          block(
            result,
            "subagent",
            `subagents.${id}`,
            `OpenCode agents have no exact equivalent for: ${unsupported.join(", ")}`
          )
          continue
        }
        const data: Json = { description: parsed.data.description, mode: "subagent" }
        result.files.set(`.opencode/agents/${id}.md`, matter.stringify(parsed.content, data))
      }
      save(result.files, "opencode.json", { $schema: "https://opencode.ai/config.json", mcp })
    } else if (target === "agent-plugins" || target === "copilot") {
      save(result.files, "plugin.json", { $schema: AGENT_PLUGINS_SCHEMA, ...metadata })
      if (Object.keys(servers).length) {
        const portable = Object.fromEntries(
          Object.entries(servers).map(([name, value]) => {
            const server = replaceRootTokens(
              value,
              ["${CLAUDE_PLUGIN_ROOT}"],
              [],
              "${PLUGIN_ROOT}"
            ) as Json
            if (server.type === "stdio" && server.cwd === undefined)
              block(
                result,
                "mcp",
                `mcpServers.${name}.cwd`,
                "Portable MCP defaults cwd to the plugin root; an explicit working directory is required to preserve source behavior"
              )
            if (
              server.cwd !== undefined &&
              (typeof server.cwd !== "string" ||
                !/^(?:\.\/|\$\{PLUGIN_ROOT\}(?:\/|$))/.test(server.cwd))
            )
              block(
                result,
                "mcp",
                `mcpServers.${name}.cwd`,
                "Working directory is not representable by the portable plugin-root contract"
              )
            if (typeof server.command === "string" && server.command.startsWith("${PLUGIN_ROOT}/"))
              server.command = `./${server.command.slice("${PLUGIN_ROOT}/".length)}`
            if (typeof server.command === "string" && server.command.includes("${"))
              block(
                result,
                "mcp",
                `mcpServers.${name}.command`,
                "Agent Plugins never expands variables in command"
              )
            if (server.type !== "stdio" && JSON.stringify(server).includes("${PLUGIN_ROOT}"))
              block(
                result,
                "mcp",
                `mcpServers.${name}`,
                "Agent Plugins passes remote server values through literally"
              )
            if (
              object(server.env) &&
              ["PLUGIN_ROOT", "PLUGIN_DATA"].some((key) => key in (server.env as Json))
            )
              block(
                result,
                "mcp",
                `mcpServers.${name}.env`,
                "Portable MCP reserved runtime variables cannot be overridden"
              )
            return [
              name,
              { ...server, type: server.type === "http" ? "streamable-http" : server.type },
            ]
          })
        )
        save(result.files, "mcp.json", { $schema: AP_MCP_SCHEMA("1.0.0"), mcpServers: portable })
      }
      if (target === "copilot") {
        projectAgents("com.github.copilot/agents", ".agent.md", ["name", "description"], "Copilot")
        if (hooksText !== undefined) {
          consumed.add("hooks/hooks.json")
          result.files.delete("hooks/hooks.json")
          block(
            result,
            "command-hooks",
            "commandHooks",
            "Copilot hook files use Copilot's own contract (version 1, flat bash/powershell entries, preToolUse fail-closed on non-zero exit); no exact projection exists"
          )
        }
      } else {
        projectAgents("dev.openhands/agents", ".md", ["name", "description"], "OpenHands")
        projectHooks("dev.openhands/hooks/hooks.json", HOOK_DIALECTS.openhands, "${PLUGIN_ROOT}")
        if (agentFiles.length || hooksText !== undefined)
          warn(
            result,
            "client-namespace",
            "dev.openhands/",
            "Agents and hooks are written to the dev.openhands/ client namespace; other Agent Plugins hosts ignore client namespaces they do not support"
          )
      }
    } else if (target === "kimi") {
      if (Object.keys(servers).length)
        block(result, "mcp", "mcpServers", "Kimi plugins cannot declare MCP servers")
      for (const agentPath of agentFiles) {
        consumed.add(agentPath)
        result.files.delete(agentPath)
        block(result, "subagent", agentPath, "Kimi plugins cannot declare subagents")
      }
      if (hooksText !== undefined) {
        consumed.add("hooks/hooks.json")
        result.files.delete("hooks/hooks.json")
        block(result, "command-hooks", "hooks/hooks.json", "Kimi plugins cannot declare hooks")
      }
      const skillFiles = [...result.files.keys()].filter((path) =>
        /^skills\/[^/]+\/SKILL\.md$/.test(path)
      )
      if (skillFiles.length > 1)
        block(
          result,
          "skills",
          "skills",
          "A Kimi plugin directory holds exactly one root SKILL.md; split the skills into separate plugins"
        )
      else if (skillFiles.length === 1) {
        const prefix = skillFiles[0].slice(0, -"SKILL.md".length)
        for (const [path, text] of Array.from(result.files)) {
          if (!path.startsWith(prefix)) continue
          const relative = path.slice(prefix.length)
          if (result.files.has(relative) && !path.startsWith("skills/"))
            block(
              result,
              "skills",
              relative,
              "Moving the skill to the plugin root would overwrite another bundled file"
            )
          result.files.set(relative, text)
          result.files.delete(path)
        }
      }
      save(result.files, "plugin.json", {
        name: metadata.name,
        version: typeof metadata.version === "string" ? metadata.version : "0.1.0",
        ...(metadata.description ? { description: metadata.description } : {}),
        tools: [],
      })
    } else {
      const manifest: Json = { ...metadata, ...(source.skills ? { skills: source.skills } : {}) }
      if (
        target === "devin" &&
        typeof metadata.name === "string" &&
        !/^[a-z0-9]+(?:[-.][a-z0-9]+)*$/.test(metadata.name)
      )
        block(
          result,
          "name",
          ".devin-plugin/plugin.json.name",
          "Devin plugin names are lowercase alphanumerics separated by single - or ."
        )
      if (target === "cursor") {
        if (
          typeof metadata.name !== "string" ||
          !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(metadata.name)
        )
          block(
            result,
            "name",
            ".cursor-plugin/plugin.json.name",
            "Cursor plugin names must be lowercase kebab-case"
          )
        if (object(metadata.author))
          manifest.author = Object.fromEntries(
            Object.entries(metadata.author).filter(([key]) => key !== "url")
          )
        projectAgents("agents", ".md", ["name", "description"], "Cursor")
        projectHooks("hooks/hooks.json", HOOK_DIALECTS.cursor, "${CURSOR_PLUGIN_ROOT}")
        if (options.variables?.length)
          manifest.variables = {
            type: "object",
            properties: Object.fromEntries(
              options.variables.map((variable) => [
                variable.envVar,
                {
                  type: "string",
                  title: variable.name,
                  ...(variable.description ? { description: variable.description } : {}),
                },
              ])
            ),
            required: options.variables.map((variable) => variable.envVar),
          }
      }
      const token = target === "cursor" ? "${CURSOR_PLUGIN_ROOT}" : "${CLAUDE_PLUGIN_ROOT}"
      if (Object.keys(servers).length) {
        const projected = replaceRootTokens(servers, ["${CLAUDE_PLUGIN_ROOT}"], [], token) as Json
        const path = target === "cursor" ? "mcp.json" : ".mcp.json"
        save(result.files, path, { mcpServers: projected })
        manifest.mcpServers = `./${path}`
      }
      save(result.files, PLATFORM_BUNDLE_PROFILES[target].manifest, manifest)
    }
    // Copilot export writes an Agent Plugins bundle, so the portable rules apply.
    inventory(result.files, result, target === "copilot" ? "agent-plugins" : target, consumed)
    if (target === "copilot")
      for (const path of result.files.keys())
        if (path.startsWith("dev.openhands/"))
          block(result, "platform-control", path, "Copilot ignores the OpenHands client namespace")
    warn(
      result,
      "compatibility",
      PLATFORM_BUNDLE_PROFILES[target].manifest,
      "Native host installation and execution require separate verification"
    )
  } catch (error) {
    block(result, "format", CLAUDE_MANIFEST, error instanceof Error ? error.message : String(error))
  }
  return result
}
