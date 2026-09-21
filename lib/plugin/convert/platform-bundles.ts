/** Native package adapters. A supported package shape does not imply runtime equivalence. */
import matter from "gray-matter"

export type PlatformBundleTarget =
  "agent-plugins" | "cursor" | "copilot" | "kimi" | "devin" | "opencode" | "pi"

export interface PlatformBundleIssue {
  capability: string
  path: string
  message: string
  blocking: boolean
}

export interface PlatformBundleProjection {
  files: Map<string, string>
  blocking: PlatformBundleIssue[]
  warnings: PlatformBundleIssue[]
}

export const AGENT_PLUGINS_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json"
const MCP_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json"
const CLAUDE_MANIFEST = ".claude-plugin/plugin.json"
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

export const PLATFORM_BUNDLE_PROFILES = {
  "agent-plugins": {
    manifest: "plugin.json",
    surfaces: ["cli", "desktop"],
    skills: "native",
    mcp: "native",
    agents: "vendor-extension",
    hooks: "vendor-extension",
  },
  cursor: {
    manifest: ".cursor-plugin/plugin.json",
    surfaces: ["desktop"],
    skills: "native",
    mcp: "native",
    agents: "adapter-required",
    hooks: "adapter-required",
  },
  copilot: {
    manifest: ".github/plugin/plugin.json",
    surfaces: ["cli", "desktop", "cloud"],
    skills: "native",
    mcp: "native",
    agents: "adapter-required",
    hooks: "surface-dependent",
  },
  kimi: {
    manifest: "kimi.plugin.json",
    surfaces: ["cli"],
    skills: "native",
    mcp: "native",
    agents: "adapter-required",
    hooks: "adapter-required",
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
    agents: "adapter-required",
    hooks: "runtime-port-required",
  },
  pi: {
    manifest: "package.json",
    surfaces: ["cli"],
    skills: "native",
    mcp: "extension-required",
    agents: "extension-required",
    hooks: "runtime-port-required",
  },
} as const

type Files = ReadonlyMap<string, string>
type Json = Record<string, unknown>

function object(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function read(files: Files, path: string): Json {
  const value: unknown = JSON.parse(files.get(path) ?? "{}")
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
  result: PlatformBundleProjection,
  capability: string,
  path: string,
  message: string
): void {
  result.blocking.push({ capability, path, message, blocking: true })
}

function save(files: Map<string, string>, path: string, value: Json): void {
  files.set(path, `${JSON.stringify(value, null, 2)}\n`)
}

/** Root plugin.json is portable only with a recognized schema family, never by filename alone. */
export function detectPlatformBundle(files: Files): PlatformBundleTarget | null {
  const markers: Array<[string, PlatformBundleTarget]> = [
    [".devin-plugin/plugin.json", "devin"],
    [".cursor-plugin/plugin.json", "cursor"],
    ["kimi.plugin.json", "kimi"],
    [".kimi-plugin/plugin.json", "kimi"],
    [".github/plugin/plugin.json", "copilot"],
    [".github/plugin.json", "copilot"],
    ["opencode.json", "opencode"],
    ["opencode.jsonc", "opencode"],
  ]
  for (const [path, target] of markers) if (files.has(path)) return target
  try {
    const root = read(files, "plugin.json")
    if (typeof root.$schema === "string" && root.$schema.startsWith("https://agent-plugins.org/"))
      return "agent-plugins"
    const pkg = read(files, "package.json")
    if (object(pkg.pi) || (Array.isArray(pkg.keywords) && pkg.keywords.includes("pi-package")))
      return "pi"
  } catch {
    return null
  }
  return null
}

function manifestPath(files: Files, target: PlatformBundleTarget): string {
  if (target === "kimi" && !files.has("kimi.plugin.json")) return ".kimi-plugin/plugin.json"
  if (target === "copilot" && files.has(".github/plugin.json")) return ".github/plugin.json"
  if (target === "copilot" && !files.has(".github/plugin/plugin.json") && files.has("plugin.json"))
    return "plugin.json"
  if (target === "opencode" && !files.has("opencode.json")) return "opencode.jsonc"
  return PLATFORM_BUNDLE_PROFILES[target].manifest
}

function inventory(files: Files, result: PlatformBundleProjection): void {
  const unsafe =
    /^(?:(?:\.opencode\/)?(?:agents?|commands?|hooks|rules|policies|extensions|plugins|prompts|themes|output-styles)\/|com\.[^/]+\/|(?:AGENTS|CLAUDE|GEMINI)\.md$|(?:hooks|lsp|\.lsp|\.app)\.json$)/
  for (const path of files.keys()) {
    if (path.startsWith("/") || path.split(/[\\/]/).includes("..") || path.includes("\\")) {
      block(result, "path", path, "Bundle paths must be relative canonical paths without traversal")
    } else if (unsafe.test(path)) {
      block(
        result,
        path.includes("hook") ? "hooks" : "platform-control",
        path,
        "Platform-specific runtime, agent, command or policy semantics require an explicit adapter or hosted use"
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

function validateManifestContract(
  source: Json,
  target: PlatformBundleTarget,
  path: string,
  result: PlatformBundleProjection
): void {
  if (
    target === "kimi" &&
    (typeof source.name !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(source.name))
  )
    block(result, "name", `${path}.name`, "Kimi plugin ids must match [a-z0-9][a-z0-9_-]{0,63}")
  if (target !== "agent-plugins" && target !== "copilot") return
  if (
    typeof source.name !== "string" ||
    source.name.length > 64 ||
    !/^(?!.*(?:--|\.\.))[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(source.name)
  )
    block(result, "name", `${path}.name`, "Name is invalid for the Agent Plugins 1.0 manifest")
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

function rootTokens(value: unknown, from: string, to: string): unknown {
  if (typeof value === "string") return value.replaceAll(from, to)
  if (Array.isArray(value)) return value.map((entry) => rootTokens(entry, from, to))
  if (object(value))
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, rootTokens(entry, from, to)])
    )
  return value
}

/** Tool names and pre-approval are host contracts, not portable skill restrictions. */
function adaptSkillSemantics(
  files: Files,
  result: PlatformBundleProjection,
  target: PlatformBundleTarget,
  direction: "import" | "export"
): void {
  const skillPaths = [...files.keys()].filter(
    (path) => path === "SKILL.md" || path.endsWith("/SKILL.md")
  )
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
      const text = files.get(path)!
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
      if (direction === "import" && target === "devin" && data.triggers !== undefined) {
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
        const directoryName = path.split("/").at(-2)
        if (target !== "pi" && target !== "devin" && directoryName && data.name !== directoryName)
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
    /\$(?:\{(?:COGNIA_PLUGIN_ROOT|CLAUDE_PLUGIN_ROOT|CLAUDE_PLUGIN_DATA|CLAUDE_PROJECT_DIR|CLAUDE_SKILL_DIR|CODEX_PLUGIN_ROOT|PLUGIN_ROOT|PLUGIN_DATA|CURSOR_PLUGIN_ROOT|KIMI_PLUGIN_ROOT|KIMI_SKILL_DIR|extensionPath|workspacePath)\}|(?:CLAUDE_PLUGIN_ROOT|PLUGIN_ROOT|PLUGIN_DATA|KIMI_SKILL_DIR)\b)/
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
    if (
      direction === "import" &&
      target === "pi" &&
      /^skills\/[^/]+\.md$/.test(path) &&
      path !== "skills/SKILL.md"
    )
      block(result, "skills", path, "Pi flat Markdown skills require explicit discovery mapping")
  }
}

function mcpServers(
  files: Files,
  source: Json,
  target: PlatformBundleTarget,
  result: PlatformBundleProjection
): Json {
  let document: Json = {}
  const declared = source.mcpServers
  if (typeof declared === "string") {
    const path = declared.replace(/^\.\//, "")
    if (!files.has(path)) throw new Error(`MCP configuration not found: ${path}`)
    document = read(files, path)
  } else if (object(declared)) {
    document = "mcpServers" in declared ? declared : { mcpServers: declared }
  } else if (declared !== undefined) {
    block(
      result,
      "mcp",
      "mcpServers",
      "This MCP declaration shape requires a platform-specific merge adapter"
    )
  } else {
    const path = target === "agent-plugins" || target === "cursor" ? "mcp.json" : ".mcp.json"
    if (files.has(path)) document = read(files, path)
  }
  if (target === "opencode") document = { mcpServers: source.mcp ?? {} }
  checkFields(document, ["$schema", "mcpServers"], "mcp", result)
  if (target === "agent-plugins" && Object.keys(document).length) {
    checkFields(document, ["$schema", "mcpServers"], "mcp.json", result)
    if (document.$schema !== MCP_SCHEMA)
      block(
        result,
        "schema",
        "mcp.json.$schema",
        "Unsupported or missing Agent Plugins MCP schema version"
      )
  }
  const servers = document.mcpServers ?? {}
  if (!object(servers)) throw new Error("mcpServers must be an object")
  const output: Json = {}
  for (const [name, value] of Object.entries(servers)) {
    if (!object(value)) throw new Error(`MCP server ${name} must be an object`)
    let server = { ...value }
    if (target === "opencode") {
      checkFields(
        server,
        ["type", "command", "environment", "url", "headers", "enabled"],
        `mcp.${name}`,
        result
      )
      if (server.enabled === false)
        block(result, "mcp", `mcp.${name}.enabled`, "Disabled-server state cannot be discarded")
      if (server.type === "local" && Array.isArray(server.command) && server.command.length > 0) {
        server = {
          command: server.command[0],
          args: server.command.slice(1),
          ...(server.environment ? { env: server.environment } : {}),
        }
      } else if (server.type === "remote") {
        block(
          result,
          "mcp",
          `mcp.${name}`,
          "OpenCode remote transport fallback and OAuth require explicit resolution before conversion"
        )
        continue
      } else throw new Error(`Invalid OpenCode MCP server: ${name}`)
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
    if (
      JSON.stringify(server).includes("${PLUGIN_DATA}") ||
      JSON.stringify(server).includes("${CLAUDE_PLUGIN_DATA}")
    ) {
      block(
        result,
        "runtime-data",
        `mcpServers.${name}`,
        "Persistent plugin data lifecycle needs a verified binding"
      )
    }
    if (target === "agent-plugins" || target === "kimi") {
      if (typeof server.command === "string" && server.command.startsWith("./"))
        server.command = `\${CLAUDE_PLUGIN_ROOT}/${server.command.slice(2)}`
      if (type === "stdio" && server.cwd === undefined) server.cwd = "${CLAUDE_PLUGIN_ROOT}"
      if (typeof server.cwd === "string" && server.cwd.startsWith("./"))
        server.cwd = `\${CLAUDE_PLUGIN_ROOT}/${server.cwd.slice(2)}`
    }
    const rootToken =
      target === "agent-plugins"
        ? "${PLUGIN_ROOT}"
        : target === "cursor"
          ? "${CURSOR_PLUGIN_ROOT}"
          : null
    if (rootToken) server = rootTokens(server, rootToken, "${CLAUDE_PLUGIN_ROOT}") as Json
    if (
      target === "agent-plugins" &&
      object(server.env) &&
      ["PLUGIN_ROOT", "PLUGIN_DATA"].some((key) => key in (server.env as Json))
    ) {
      block(
        result,
        "mcp",
        `mcpServers.${name}.env`,
        "Portable MCP reserved runtime variables cannot be overridden"
      )
    }
    output[name] = { ...server, type: type === "streamable-http" ? "http" : type }
  }
  return output
}

/** Normalize only proven declarative contributions for the existing Claude bundle parser. */
export function normalizePlatformBundle(
  files: Files,
  target: PlatformBundleTarget
): PlatformBundleProjection {
  const result: PlatformBundleProjection = { files: new Map(files), blocking: [], warnings: [] }
  inventory(files, result)
  adaptSkillSemantics(files, result, target, "import")
  try {
    const path = manifestPath(files, target)
    if (!files.has(path)) throw new Error(`Manifest not found: ${path}`)
    const source = read(files, path)
    validateManifestContract(source, target, path, result)
    if (target === "copilot" && path === "plugin.json" && source.$schema === AGENT_PLUGINS_SCHEMA)
      return normalizePlatformBundle(files, "agent-plugins")
    const native = target === "pi" ? (object(source.pi) ? source.pi : {}) : source
    const allowed =
      target === "agent-plugins"
        ? [...METADATA, "$schema", "extensions"]
        : target === "opencode"
          ? ["$schema", "mcp"]
          : target === "pi"
            ? ["skills"]
            : [...METADATA, "skills", "mcpServers"]
    checkFields(native, allowed, path, result)
    if (target === "agent-plugins") {
      if (source.$schema !== AGENT_PLUGINS_SCHEMA)
        block(result, "schema", `${path}.$schema`, "Only Agent Plugins 1.0.0 is supported")
      if (present(source.extensions))
        block(
          result,
          "extensions",
          `${path}.extensions`,
          "Vendor extensions require explicit semantic adapters"
        )
    }
    if (target === "pi") {
      checkFields(source, [...METADATA, "pi"], path, result)
      if (present(source.dependencies) || present(source.scripts))
        block(
          result,
          "runtime",
          path,
          "Pi dependency installation and scripts require a runtime port or hosted use"
        )
    }
    const name = target === "opencode" ? "opencode-resource-bundle" : source.name
    if (typeof name !== "string" || !name.trim()) throw new Error(`${path}.name is required`)
    const manifest: Json = Object.fromEntries(
      METADATA.filter((key) => source[key] !== undefined).map((key) => [key, source[key]])
    )
    manifest.name = name
    if (native.skills !== undefined) manifest.skills = native.skills
    else if (target === "opencode") manifest.skills = "./.opencode/skills"
    else if (target === "kimi") {
      if (files.has("SKILL.md")) manifest.skills = "./SKILL.md"
      else if (
        [...files.keys()].some((file) => file.startsWith("skills/") && file.endsWith("/SKILL.md"))
      ) {
        block(
          result,
          "skills",
          "skills",
          "Kimi only discovers the root SKILL.md when manifest.skills is omitted; undeclared skills cannot be activated by conversion"
        )
      }
    }
    if (Array.isArray(native.skills) && native.skills.length === 0)
      block(
        result,
        "skills",
        `${path}.skills`,
        "An empty skill selection cannot fall back to automatic discovery"
      )
    const servers = target === "pi" ? {} : mcpServers(files, source, target, result)
    // Installers overlay the original tree; deleting a raw config from this
    // map would leave credentials in the installed source. Replace it instead.
    result.files.set(path, "{}\n")
    for (const configPath of [
      "mcp.json",
      ...(typeof source.mcpServers === "string" ? [source.mcpServers.replace(/^\.\//, "")] : []),
    ]) {
      if (files.has(configPath) && configPath !== CLAUDE_MANIFEST)
        result.files.set(configPath, "{}\n")
    }
    if (Object.keys(servers).length) {
      save(result.files, ".mcp.json", { mcpServers: servers })
      manifest.mcpServers = "./.mcp.json"
    }
    save(result.files, CLAUDE_MANIFEST, manifest)
    result.warnings.push({
      capability: "compatibility",
      path,
      message: "Declarative normalization only; native host execution has not been verified",
      blocking: false,
    })
  } catch (error) {
    block(
      result,
      "format",
      manifestPath(files, target),
      error instanceof Error ? error.message : String(error)
    )
  }
  return result
}

/** Project a validated Claude-shaped skill/MCP bundle; never port its executable lifecycle. */
export function projectPlatformBundle(
  files: Files,
  target: PlatformBundleTarget
): PlatformBundleProjection {
  const result: PlatformBundleProjection = { files: new Map(files), blocking: [], warnings: [] }
  inventory(files, result)
  adaptSkillSemantics(files, result, target, "export")
  try {
    if (!files.has(CLAUDE_MANIFEST))
      throw new Error("A validated Claude bundle manifest is required")
    const source = read(files, CLAUDE_MANIFEST)
    checkFields(
      source,
      [...METADATA, "displayName", "skills", "mcpServers"],
      CLAUDE_MANIFEST,
      result
    )
    const metadata = Object.fromEntries(
      METADATA.filter((key) => source[key] !== undefined).map((key) => [key, source[key]])
    )
    validateManifestContract(metadata, target, PLATFORM_BUNDLE_PROFILES[target].manifest, result)
    if (
      ["agent-plugins", "copilot", "pi", "opencode"].includes(target) &&
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
    const servers = mcpServers(files, source, "devin", result)
    result.files.delete(CLAUDE_MANIFEST)
    result.files.delete(".mcp.json")
    if (target === "pi") {
      if (Object.keys(servers).length)
        block(
          result,
          "mcp",
          "mcpServers",
          "Pi core requires an MCP extension; select hosted use or a verified runtime adapter"
        )
      save(result.files, "package.json", {
        ...metadata,
        keywords: ["pi-package"],
        pi: { skills: ["./skills"] },
      })
    } else if (target === "opencode") {
      result.warnings.push({
        capability: "metadata",
        path: "opencode.json",
        message:
          "OpenCode resource configuration has no native plugin identity metadata; imported identity will be generated",
        blocking: false,
      })
      const mcp: Json = {}
      for (const [name, value] of Object.entries(servers)) {
        const server = value as Json
        if (
          server.type !== "stdio" ||
          server.cwd !== undefined ||
          JSON.stringify(server).includes("${")
        ) {
          block(
            result,
            "mcp",
            `mcpServers.${name}`,
            "OpenCode export requires a PATH command without plugin-relative paths, cwd or unresolved variables"
          )
          continue
        }
        mcp[name] = {
          type: "local",
          command: [server.command, ...((server.args as string[]) ?? [])],
          ...(server.env ? { environment: server.env } : {}),
        }
      }
      for (const [path, text] of Array.from(result.files))
        if (path.startsWith("skills/")) {
          result.files.set(`.opencode/${path}`, text)
          result.files.delete(path)
        }
      save(result.files, "opencode.json", { $schema: "https://opencode.ai/config.json", mcp })
    } else if (target === "agent-plugins" || target === "copilot") {
      save(result.files, "plugin.json", { $schema: AGENT_PLUGINS_SCHEMA, ...metadata })
      if (Object.keys(servers).length) {
        const portable = Object.fromEntries(
          Object.entries(servers).map(([name, value]) => {
            const server = rootTokens(value, "${CLAUDE_PLUGIN_ROOT}", "${PLUGIN_ROOT}") as Json
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
        save(result.files, "mcp.json", { $schema: MCP_SCHEMA, mcpServers: portable })
      }
    } else {
      const manifest: Json = { ...metadata, ...(source.skills ? { skills: source.skills } : {}) }
      const token = target === "cursor" ? "${CURSOR_PLUGIN_ROOT}" : "${CLAUDE_PLUGIN_ROOT}"
      if (Object.keys(servers).length) {
        if (target === "kimi" && JSON.stringify(servers).includes("${CLAUDE_PLUGIN_ROOT}"))
          block(
            result,
            "mcp",
            "mcpServers",
            "Kimi plugin-relative executable and working-directory mappings require a dedicated adapter"
          )
        const projected = rootTokens(servers, "${CLAUDE_PLUGIN_ROOT}", token) as Json
        if (target === "kimi") manifest.mcpServers = projected
        else {
          const path = target === "cursor" ? "mcp.json" : ".mcp.json"
          save(result.files, path, { mcpServers: projected })
          manifest.mcpServers = `./${path}`
        }
      }
      save(result.files, PLATFORM_BUNDLE_PROFILES[target].manifest, manifest)
    }
    result.warnings.push({
      capability: "compatibility",
      path: PLATFORM_BUNDLE_PROFILES[target].manifest,
      message: "Native host installation and execution require separate verification",
      blocking: false,
    })
  } catch (error) {
    block(result, "format", CLAUDE_MANIFEST, error instanceof Error ? error.message : String(error))
  }
  return result
}
