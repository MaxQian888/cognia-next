/**
 * Claude-family plugin layouts.
 *
 * Several hosts adopted the Claude Code plugin layout (`.<vendor>-plugin/
 * plugin.json`, `skills/`, `agents/`, `commands/`, `hooks/hooks.json`, an MCP
 * file) and then diverged in details: the manifest directory, the agents
 * directory name, the MCP file name, the plugin-root variable, which manifest
 * keys are honored, which hook events and handler types run, and which agent
 * frontmatter has an exact Cognia equivalent. A profile records those details
 * once so the Claude converter (import) and `projectClaudeFamilyBundle`
 * (export) stay a single implementation instead of one copy per vendor.
 *
 * Sources (researched 2026-10-02): code.claude.com plugins reference
 * (v2.1.283), docs.factory.ai/harness/plugins, docs.qoder.com/cli/plugins,
 * codebuddy.ai/docs/cli/plugins-reference, docs.augmentcode.com/cli/plugins,
 * docs.openhands.dev/sdk/guides/plugins (legacy OpenPlugin `.plugin/`).
 */

import matter from "gray-matter"
import { HOOK_DIALECTS, canonicalHooksToDialect, type HookDialect } from "./hook-dialects"
import type { HooksConfig } from "@/lib/claude/hooks"

export type ClaudeFamilyEcosystem =
  "claude-code" | "factory-droid" | "qoder" | "codebuddy" | "auggie" | "open-plugins"

export interface ClaudeFamilyIssue {
  capability: string
  path: string
  message: string
  blocking: boolean
}

export interface ClaudeFamilyProfile {
  ecosystem: ClaudeFamilyEcosystem
  label: string
  /** Manifest locations in the host's own read order. */
  manifestPaths: readonly string[]
  /** Where an exported manifest is written. */
  exportManifestPath: string
  /** Metadata keys carried into the Cognia identity. */
  metadataFields: readonly string[]
  /** Component path keys the host honors in its manifest. */
  componentFields: readonly string[]
  /** Keys the host reads for presentation only, or ignores: reported, not blocking. */
  ignoredFields: Readonly<Record<string, string>>
  /** Keys that carry behavior Cognia cannot reproduce. */
  blockedFields: Readonly<Record<string, string>>
  /** What happens to a key the profile does not list. */
  unknownFields: "warn" | "block"
  /**
   * Conventional paths (prefix ending in `/`, or an exact file) that carry
   * unconverted behavior. `warn` marks surfaces whose bytes convert but whose
   * host-side effect does not (Claude's `bin/` PATH entry).
   */
  blockedPaths: ReadonlyArray<{ path: string; capability: string; message: string; warn?: boolean }>
  /** Conventional agents directory. */
  agentsDir: string
  /** Agent file → agent id, or null when the file is not an agent definition. */
  agentId: (relativePath: string) => string | null
  /**
   * Frontmatter keys with an exact Cognia subagent equivalent. `null` keeps
   * the Claude parser's own field handling (Claude Code itself).
   */
  agentFields: readonly string[] | null
  /** Frontmatter values that only restate Cognia's default and are dropped on import. */
  agentDefaults?: Readonly<Record<string, string>>
  /** Conventional commands directory, or null when the host has none. */
  commandsDir: string | null
  /** Conventional MCP file at the plugin root. */
  mcpFile: string
  /** Declared MCP paths add to the conventional file, replace it, or are undocumented. */
  mcpMode: "merge" | "replace" | "ambiguous"
  /** Declared skill paths add to `skills/`, replace it, or are undocumented. */
  skillsMode: "additive" | "replace" | "ambiguous"
  /** Conventional hook files, read when the manifest declares none. */
  hookFiles: readonly string[]
  /** Declared hooks add to the conventional files, replace them, or are undocumented. */
  hooksMode: "merge" | "replace" | "ambiguous"
  hookDialect: HookDialect
  /** Plugin-root tokens the host expands; the first is used on export. */
  rootTokens: readonly string[]
  /** Bare `$VAR` forms the host exports to hook processes. */
  rootEnvVars: readonly string[]
  /** Persistent-data tokens the host expands (no Cognia binding exists). */
  dataTokens: readonly string[]
  /** Whether `${CLAUDE_PLUGIN_ROOT}` also expands in this host. */
  claudeRootAlias: boolean
  /** Component paths must start with `./` (Claude Code validation). */
  requireDotSlashPaths: boolean
  /** Manifest `name` rule enforced by the host. */
  nameRule: { pattern: RegExp; message: string }
  /** Names the host reserves for its vendor; blocking on export only. */
  reservedNames?: { pattern: RegExp; message: string }
  /** Write component path keys into exported manifests (otherwise rely on conventions). */
  exportComponentPaths: boolean
}

const METADATA = [
  "name",
  "version",
  "description",
  "author",
  "homepage",
  "repository",
  "license",
  "keywords",
] as const

const markdownAgentId = (path: string): string | null => {
  const match = /^([^/]+)\.md$/i.exec(path)
  return match ? match[1] : null
}

const CLAUDE_BLOCKED: Record<string, string> = {
  lspServers: "LSP servers need a language-server host; Cognia has no plugin LSP contribution",
  outputStyles: "Output styles replace the host's response style; Cognia has no equivalent",
  workflows: "Plugin workflows (workflows/*.js) are executable host code",
  settings:
    "Plugin settings (agent, subagentStatusLine) change the host session; Cognia has no equivalent",
  userConfig:
    "userConfig prompts for values substituted as ${user_config.KEY}; no exact Cognia projection exists yet",
  channels: "Channels inject messages from external services into the session",
  dependencies: "Plugin dependencies install other plugins from a marketplace",
  experimental: "Experimental themes, monitors and evals have no Cognia equivalent",
  types: "Type declarations configure host-specific component typing",
}

const CLAUDE_PATHS = [
  { path: "monitors/", capability: "monitors", message: "Background monitors run host code" },
  { path: "themes/", capability: "themes", message: "Themes restyle the host UI" },
  { path: "workflows/", capability: "workflows", message: "Workflows are executable host code" },
  {
    path: "output-styles/",
    capability: "outputStyles",
    message: "Output styles replace the host's response style",
  },
  {
    path: "settings.json",
    capability: "settings",
    message: "Root settings.json changes host defaults",
  },
  {
    path: ".lsp.json",
    capability: "lspServers",
    message: "LSP servers need a language-server host",
  },
  {
    path: "bin/",
    capability: "bin",
    message:
      "Claude Code adds bin/ to the Bash PATH; Cognia does not, so bare-name invocations of these executables fail — reference them through the plugin root",
    warn: true,
  },
] as const

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export const CLAUDE_FAMILY_PROFILES: Readonly<Record<ClaudeFamilyEcosystem, ClaudeFamilyProfile>> =
  {
    "claude-code": {
      ecosystem: "claude-code",
      label: "Claude Code",
      manifestPaths: [".claude-plugin/plugin.json"],
      exportManifestPath: ".claude-plugin/plugin.json",
      metadataFields: [...METADATA, "displayName", "icon"],
      componentFields: ["skills", "commands", "agents", "hooks", "mcpServers"],
      ignoredFields: {
        $schema: "Schema reference only",
        metadata: "Marketplace metadata is not projected into Cognia",
        defaultEnabled:
          "Cognia enables imported plugins through its own install flow; the default is not projected",
        documentationUrl: "Directory presentation only",
        supportUrl: "Directory presentation only",
        privacyPolicyUrl: "Directory presentation only",
        termsOfServiceUrl: "Directory presentation only",
      },
      blockedFields: CLAUDE_BLOCKED,
      // Claude Code strips unknown top-level keys with a warning, so they carry no behavior.
      unknownFields: "warn",
      blockedPaths: CLAUDE_PATHS,
      agentsDir: "agents",
      agentId: markdownAgentId,
      agentFields: null,
      commandsDir: "commands",
      mcpFile: ".mcp.json",
      mcpMode: "merge",
      skillsMode: "additive",
      hookFiles: ["hooks/hooks.json", "hooks.json"],
      hooksMode: "merge",
      hookDialect: HOOK_DIALECTS["claude-code"],
      rootTokens: ["${CLAUDE_PLUGIN_ROOT}"],
      rootEnvVars: ["CLAUDE_PLUGIN_ROOT"],
      dataTokens: ["${CLAUDE_PLUGIN_DATA}"],
      claudeRootAlias: true,
      requireDotSlashPaths: true,
      nameRule: {
        pattern: /^[^\s@:/\\\p{Cc}\u200e\u200f\u202a-\u202e\u2066-\u2069]+$/u,
        message:
          "Claude Code plugin names cannot contain spaces, @, :, path separators, control or bidi characters",
      },
      exportComponentPaths: true,
      reservedNames: {
        pattern: /^(?:claude-|anthropic-|anthropics-|cc-plugin-)|^claude-code$/,
        message:
          "Claude Code reserves the claude-, anthropic-, anthropics- and cc-plugin- name prefixes",
      },
    },
    "factory-droid": {
      ecosystem: "factory-droid",
      label: "Factory Droid",
      manifestPaths: [".factory-plugin/plugin.json"],
      exportManifestPath: ".factory-plugin/plugin.json",
      metadataFields: METADATA,
      componentFields: [],
      // Droid neither requires nor reads plugin.json; identity comes from the
      // marketplace entry and components are discovered by convention only.
      ignoredFields: {
        skills: "Droid discovers skills/ by convention and does not read manifest paths",
        commands: "Droid discovers commands/ by convention and does not read manifest paths",
        agents: "Droid discovers droids/ by convention and does not read manifest paths",
        hooks: "Droid reads hooks/hooks.json by convention and does not read manifest hooks",
        mcpServers: "Droid reads mcp.json by convention and does not read manifest MCP",
        outputStyles: "Droid discovers output-styles/ by convention",
      },
      blockedFields: {},
      unknownFields: "warn",
      blockedPaths: [
        {
          path: "output-styles/",
          capability: "outputStyles",
          message: "Droid output styles replace the response style; Cognia has no equivalent",
        },
      ],
      agentsDir: "droids",
      agentId: markdownAgentId,
      agentFields: ["name", "description"],
      agentDefaults: { model: "inherit" },
      commandsDir: "commands",
      mcpFile: "mcp.json",
      mcpMode: "replace",
      skillsMode: "replace",
      hookFiles: ["hooks/hooks.json"],
      hooksMode: "replace",
      hookDialect: HOOK_DIALECTS["factory-droid"],
      rootTokens: ["${DROID_PLUGIN_ROOT}", "${CLAUDE_PLUGIN_ROOT}"],
      rootEnvVars: ["DROID_PLUGIN_ROOT", "CLAUDE_PLUGIN_ROOT"],
      dataTokens: [],
      claudeRootAlias: true,
      requireDotSlashPaths: false,
      nameRule: { pattern: /^\S+$/, message: "Droid plugin names cannot contain whitespace" },
      exportComponentPaths: false,
    },
    qoder: {
      ecosystem: "qoder",
      label: "Qoder CLI",
      manifestPaths: [".qoder-plugin/plugin.json"],
      exportManifestPath: ".qoder-plugin/plugin.json",
      metadataFields: METADATA,
      componentFields: ["skills", "commands", "agents", "hooks"],
      ignoredFields: {},
      blockedFields: {
        outputStyles: "Output styles replace the host's response style; Cognia has no equivalent",
      },
      unknownFields: "block",
      blockedPaths: [
        {
          path: "output-styles/",
          capability: "outputStyles",
          message: "Output styles replace the host's response style",
        },
        {
          path: "bin/",
          capability: "bin",
          message: "Qoder adds bin/ executables to the session; Cognia does not",
        },
      ],
      agentsDir: "agents",
      agentId: markdownAgentId,
      agentFields: ["name", "description"],
      commandsDir: "commands",
      mcpFile: ".mcp.json",
      mcpMode: "replace",
      skillsMode: "replace",
      hookFiles: ["hooks/hooks.json"],
      hooksMode: "replace",
      hookDialect: HOOK_DIALECTS.qoder,
      rootTokens: ["${QODER_PLUGIN_ROOT}"],
      rootEnvVars: ["QODER_PLUGIN_ROOT"],
      dataTokens: ["${QODER_PLUGIN_DATA}"],
      claudeRootAlias: false,
      requireDotSlashPaths: false,
      nameRule: { pattern: /^\S+$/, message: "Qoder plugin names cannot contain spaces" },
      exportComponentPaths: false,
    },
    codebuddy: {
      ecosystem: "codebuddy",
      label: "CodeBuddy",
      manifestPaths: [".codebuddy-plugin/plugin.json", ".workbuddy-plugin/plugin.json"],
      exportManifestPath: ".codebuddy-plugin/plugin.json",
      metadataFields: METADATA,
      componentFields: ["skills", "commands", "agents", "hooks", "mcpServers"],
      ignoredFields: {
        defaultEnabled:
          "Cognia enables imported plugins through its own install flow; the default is not projected",
      },
      blockedFields: {
        outputStyles: CLAUDE_BLOCKED.outputStyles,
        lspServers: CLAUDE_BLOCKED.lspServers,
        dependencies: CLAUDE_BLOCKED.dependencies,
        userConfig: CLAUDE_BLOCKED.userConfig,
        channels: CLAUDE_BLOCKED.channels,
        experimental: CLAUDE_BLOCKED.experimental,
      },
      unknownFields: "block",
      blockedPaths: [
        CLAUDE_PATHS[3],
        {
          path: ".lsp.json",
          capability: "lspServers",
          message: "LSP servers need a language-server host",
        },
      ],
      agentsDir: "agents",
      agentId: markdownAgentId,
      agentFields: ["name", "description", "effort", "maxTurns"],
      commandsDir: "commands",
      mcpFile: ".mcp.json",
      mcpMode: "merge",
      skillsMode: "replace",
      hookFiles: ["hooks/hooks.json"],
      hooksMode: "merge",
      hookDialect: HOOK_DIALECTS.codebuddy,
      rootTokens: ["${CODEBUDDY_PLUGIN_ROOT}", "${CLAUDE_PLUGIN_ROOT}"],
      rootEnvVars: ["CODEBUDDY_PLUGIN_ROOT", "CLAUDE_PLUGIN_ROOT"],
      dataTokens: ["${CODEBUDDY_PLUGIN_DATA}", "${CLAUDE_PLUGIN_DATA}"],
      claudeRootAlias: true,
      requireDotSlashPaths: false,
      nameRule: { pattern: SLUG, message: "CodeBuddy plugin names must be kebab-case" },
      exportComponentPaths: false,
    },
    auggie: {
      ecosystem: "auggie",
      label: "Auggie",
      manifestPaths: [".augment-plugin/plugin.json"],
      exportManifestPath: ".augment-plugin/plugin.json",
      metadataFields: METADATA,
      componentFields: ["skills", "commands", "agents", "hooks", "mcpServers"],
      ignoredFields: {},
      blockedFields: {},
      unknownFields: "block",
      blockedPaths: [
        {
          path: "rules/",
          capability: "rules",
          message:
            "Auggie rules are always-on instructions; Cognia plugins have no rule contribution",
        },
      ],
      agentsDir: "agents",
      agentId: markdownAgentId,
      agentFields: ["name", "description", "color"],
      commandsDir: "commands",
      mcpFile: ".mcp.json",
      mcpMode: "ambiguous",
      skillsMode: "ambiguous",
      hookFiles: ["hooks/hooks.json"],
      hooksMode: "ambiguous",
      hookDialect: HOOK_DIALECTS.auggie,
      rootTokens: ["${AUGMENT_PLUGIN_ROOT}", "${AUGGIE_PLUGIN_ROOT}", "${CLAUDE_PLUGIN_ROOT}"],
      rootEnvVars: ["AUGMENT_PLUGIN_ROOT", "AUGGIE_PLUGIN_ROOT", "CLAUDE_PLUGIN_ROOT"],
      dataTokens: [],
      claudeRootAlias: true,
      requireDotSlashPaths: false,
      nameRule: { pattern: /^\S+$/, message: "Auggie plugin names cannot contain whitespace" },
      exportComponentPaths: false,
    },
    "open-plugins": {
      ecosystem: "open-plugins",
      label: "Open Plugins (legacy .plugin)",
      manifestPaths: [".plugin/plugin.json", ".goose-plugin/plugin.json"],
      exportManifestPath: ".plugin/plugin.json",
      metadataFields: METADATA,
      componentFields: [],
      ignoredFields: {},
      blockedFields: {
        skills:
          "Legacy OpenPlugin hosts (Copilot, OpenHands, Goose) disagree on manifest path overrides",
        commands:
          "Legacy OpenPlugin hosts (Copilot, OpenHands, Goose) disagree on manifest path overrides",
        agents:
          "Legacy OpenPlugin hosts (Copilot, OpenHands, Goose) disagree on manifest path overrides",
        hooks:
          "Legacy OpenPlugin hosts (Copilot, OpenHands, Goose) disagree on manifest path overrides",
        mcpServers:
          "Legacy OpenPlugin hosts (Copilot, OpenHands, Goose) disagree on manifest path overrides",
      },
      unknownFields: "block",
      blockedPaths: [],
      agentsDir: "agents",
      agentId: (path) => {
        const match = /^([^/]+?)(?:\.agent)?\.md$/i.exec(path)
        return match ? match[1] : null
      },
      agentFields: ["name", "description"],
      commandsDir: "commands",
      mcpFile: ".mcp.json",
      mcpMode: "replace",
      skillsMode: "replace",
      hookFiles: ["hooks/hooks.json"],
      hooksMode: "replace",
      hookDialect: HOOK_DIALECTS.openhands,
      rootTokens: ["${PLUGIN_ROOT}"],
      rootEnvVars: ["PLUGIN_ROOT"],
      dataTokens: ["${PLUGIN_DATA}"],
      claudeRootAlias: false,
      requireDotSlashPaths: false,
      nameRule: { pattern: /^\S+$/, message: "Plugin names cannot contain whitespace" },
      exportComponentPaths: false,
    },
  }

/** The manifest a profile reads from a snapshot, honoring host read order. */
export function claudeFamilyManifestPath(
  files: ReadonlyMap<string, string>,
  profile: ClaudeFamilyProfile
): string | undefined {
  return profile.manifestPaths.find((path) => files.has(path))
}

/** Replace a host's plugin-root tokens (and bare env vars) with `replacement`. */
export function replaceRootTokens(
  value: unknown,
  tokens: readonly string[],
  envVars: readonly string[],
  replacement: string
): unknown {
  if (typeof value === "string") {
    let result = value
    for (const token of tokens) result = result.replaceAll(token, replacement)
    for (const name of envVars)
      result = result.replace(new RegExp(`\\$${name}(?![A-Za-z0-9_])`, "g"), replacement)
    return result
  }
  if (Array.isArray(value))
    return value.map((entry) => replaceRootTokens(entry, tokens, envVars, replacement))
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        replaceRootTokens(entry, tokens, envVars, replacement),
      ])
    )
  return value
}

interface Projection {
  files: Map<string, string>
  blocking: ClaudeFamilyIssue[]
  warnings: ClaudeFamilyIssue[]
}

const CLAUDE_MANIFEST = ".claude-plugin/plugin.json"

/**
 * Project a validated Claude Code export (the canonical intermediate the
 * Cognia exporter writes) into another Claude-family layout. Behavior that
 * the target cannot reproduce exactly is blocking.
 */
export function projectClaudeFamilyBundle(
  input: ReadonlyMap<string, string>,
  profile: ClaudeFamilyProfile
): Projection {
  const result: Projection = { files: new Map(input), blocking: [], warnings: [] }
  if (profile.ecosystem === "claude-code") return result
  const fail = (capability: string, path: string, message: string) =>
    result.blocking.push({ capability, path, message, blocking: true })
  const exportToken = profile.rootTokens[0]
  const swap = (value: unknown) =>
    replaceRootTokens(value, ["${CLAUDE_PLUGIN_ROOT}"], ["CLAUDE_PLUGIN_ROOT"], exportToken)

  const manifestText = input.get(CLAUDE_MANIFEST)
  if (manifestText === undefined) {
    fail("format", CLAUDE_MANIFEST, "A validated Claude bundle manifest is required")
    return result
  }
  const source = JSON.parse(manifestText) as Record<string, unknown>
  result.files.delete(CLAUDE_MANIFEST)
  const manifest: Record<string, unknown> = {}
  for (const key of METADATA) if (source[key] !== undefined) manifest[key] = source[key]
  if (typeof manifest.name === "string" && !profile.nameRule.pattern.test(manifest.name))
    fail("name", `${profile.exportManifestPath}.name`, profile.nameRule.message)

  // Agents: Claude writes agents/<id>.md; re-home and re-check the frontmatter.
  for (const [path, text] of Array.from(result.files)) {
    if (!path.startsWith("agents/") || !path.endsWith(".md")) continue
    result.files.delete(path)
    const id = path.slice("agents/".length, -".md".length)
    let parsed: matter.GrayMatterFile<string>
    try {
      parsed = matter(text)
    } catch (error) {
      fail("subagent", path, error instanceof Error ? error.message : String(error))
      continue
    }
    const allowed = new Set(profile.agentFields ?? [])
    const unsupported = Object.keys(parsed.data).filter((key) => !allowed.has(key))
    if (unsupported.length) {
      fail(
        "subagent",
        `subagents.${id}`,
        `${profile.label} agents have no exact equivalent for: ${unsupported.join(", ")}`
      )
      continue
    }
    const target = profile.ecosystem === "open-plugins" ? null : `${profile.agentsDir}/${id}.md`
    if (!target) {
      fail(
        "subagent",
        `subagents.${id}`,
        "Legacy OpenPlugin hosts disagree on agent files (Copilot *.agent.md, OpenHands <name>.md); export to agent-plugins or copilot instead"
      )
      continue
    }
    result.files.set(target, text)
  }

  // MCP: rename the file and rewrite root tokens inside it.
  const mcpText = result.files.get(".mcp.json")
  if (mcpText !== undefined) {
    result.files.delete(".mcp.json")
    const document = JSON.parse(mcpText) as Record<string, unknown>
    const servers = (document.mcpServers ?? {}) as Record<string, Record<string, unknown>>
    if (profile.ecosystem === "open-plugins") {
      for (const [name, server] of Object.entries(servers)) {
        if (JSON.stringify(server).includes("${CLAUDE_PLUGIN_ROOT}") || server.cwd !== undefined)
          fail(
            "mcp",
            `mcpServers.${name}`,
            "Legacy OpenPlugin hosts do not document plugin-root expansion or cwd for MCP servers; use a PATH command or a remote server"
          )
      }
    }
    result.files.set(profile.mcpFile, `${JSON.stringify(swap(document), null, 2)}\n`)
  }

  // Hooks: translate the canonical document into the host dialect.
  const hooksText = result.files.get("hooks/hooks.json")
  if (hooksText !== undefined) {
    result.files.delete("hooks/hooks.json")
    const document = JSON.parse(hooksText) as { hooks?: HooksConfig }
    const projected = canonicalHooksToDialect({
      hooks: document.hooks ?? {},
      dialect: profile.hookDialect,
      sink: result,
      path: "hooks/hooks.json",
    })
    if (projected)
      result.files.set("hooks/hooks.json", `${JSON.stringify(swap(projected), null, 2)}\n`)
  }

  // Other text resources keep `${CLAUDE_PLUGIN_ROOT}` only where the host aliases it.
  if (!profile.claudeRootAlias) {
    for (const [path, text] of result.files) {
      if (path === "hooks/hooks.json" || path === profile.mcpFile) continue
      if (text.includes("${CLAUDE_PLUGIN_ROOT}"))
        fail(
          "resources",
          path,
          `${profile.label} does not expand \${CLAUDE_PLUGIN_ROOT} in bundled resources; update the reference before exporting`
        )
    }
  }

  if (profile.exportComponentPaths) {
    for (const key of profile.componentFields)
      if (source[key] !== undefined) manifest[key] = source[key]
  }
  result.files.set(profile.exportManifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  result.warnings.push({
    capability: "compatibility",
    path: profile.exportManifestPath,
    message: `Native ${profile.label} installation and execution require separate verification`,
    blocking: false,
  })
  return result
}
