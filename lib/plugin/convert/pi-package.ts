/**
 * Pi packages ⇄ Cognia plugins.
 *
 * A Pi package (github.com/earendil-works/pi, `@earendil-works/pi-coding-agent`
 * 1.0.0, docs/packages.md) is a directory with a `package.json`. Its resources
 * come from the `pi` manifest key (`extensions`, `skills`, `prompts`,
 * `themes`: arrays of paths or globs; `!`/`+`/`-` overrides) or, when the key
 * is absent, from the conventional `extensions/`, `skills/`, `prompts/` and
 * `themes/` directories. The discovery below mirrors Pi's own
 * `package-manager.ts` rules so conversion selects exactly what Pi would load.
 *
 * Import keeps the WHOLE package byte-for-byte in place (`piPackages[0].path
 * === "."`): extensions, themes and runtime dependencies stay Pi-only, while
 * skills and prompts additionally become Cognia skills. The package is not
 * relocated because the GitHub and Load-unpacked installers copy the source
 * tree verbatim and may only overlay `plugin.json` and `dist/index.js`
 * (`crates/cognia-plugin-runtime/src/generated_files.rs`); moving bytes would
 * be impossible there. Export writes the package root back out and merges
 * Cognia skills into it.
 *
 * Pure: no IO, nothing executed. Extension source is scanned as text only to
 * describe what stays Pi-only.
 */

import matter from "gray-matter"
import type { PluginManifest } from "@/types/plugin/plugin"
import type { PluginPiPackageDef } from "@/types/plugin/plugin-pi-package"
import type { PluginSkillDef } from "@/types/plugin/plugin-skill"
import { slugify } from "./identity"

export interface PiIssue {
  capability: string
  path: string
  message: string
  blocking: boolean
}

export interface PiIssues {
  converted: PiIssue[]
  warnings: PiIssue[]
  blocking: PiIssue[]
}

type Files = ReadonlyMap<string, string>
type Json = Record<string, unknown>

export const PI_RESOURCE_TYPES = ["extensions", "skills", "prompts", "themes"] as const
export type PiResourceType = (typeof PI_RESOURCE_TYPES)[number]

/** Packages Pi provides to extensions; they belong in peerDependencies ("*"), never bundled. */
export const PI_HOST_PACKAGES = [
  "@earendil-works/pi-ai",
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
  "typebox",
] as const

/** npm lifecycle scripts; Cognia's `prepare` runs npm with --ignore-scripts. */
const LIFECYCLE_SCRIPTS = [
  "preinstall",
  "install",
  "postinstall",
  "prepare",
  "preprepare",
  "postprepare",
  "prepublish",
  "prepublishOnly",
  "prepack",
  "postpack",
]

/** Fixed, reviewable dependency step for a package with runtime dependencies. */
export const PI_PREPARE_ARGS = [
  "install",
  "--omit=dev",
  "--omit=peer",
  "--ignore-scripts",
  "--no-audit",
  "--no-fund",
] as const

export const PI_PACKAGE_ID_FALLBACK = "pi-package"

const IGNORE_FILES = new Set([".gitignore", ".ignore", ".fdignore"])

function isRecord(value: unknown): value is Json {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function issue(
  sink: PiIssues,
  kind: keyof PiIssues,
  capability: string,
  path: string,
  message: string
): void {
  sink[kind].push({ capability, path, message, blocking: kind === "blocking" })
}

/** Minimal minimatch-compatible glob: `*`, `**`, `?`, `{a,b}`, `[…]`. */
export function piGlobToRegExp(pattern: string): RegExp {
  let source = ""
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index]
    if (char === "*") {
      if (pattern[index + 1] === "*") {
        const slashAfter = pattern[index + 2] === "/"
        source += slashAfter ? "(?:[^/]*(?:/|$))*" : ".*"
        index += slashAfter ? 2 : 1
      } else source += "[^/]*"
    } else if (char === "?") source += "[^/]"
    else if (char === "{") {
      const end = pattern.indexOf("}", index)
      if (end < 0) source += "\\{"
      else {
        source += `(?:${pattern
          .slice(index + 1, end)
          .split(",")
          .map((part) => part.replace(/[.+^$()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*"))
          .join("|")})`
        index = end
      }
    } else if (char === "[") {
      const end = pattern.indexOf("]", index)
      if (end < 0) source += "\\["
      else {
        source += `[${pattern.slice(index + 1, end).replace(/^!/, "^")}]`
        index = end
      }
    } else source += char.replace(/[.+^$()|\\/]/g, "\\$&")
  }
  return new RegExp(`^${source}$`)
}

function stripDot(path: string): string {
  return path.replace(/^\.\//, "").replace(/\/+$/, "")
}

function basename(path: string): string {
  return path.split("/").pop() ?? path
}

function dirname(path: string): string {
  const index = path.lastIndexOf("/")
  return index < 0 ? "" : path.slice(0, index)
}

function hasDotSegment(path: string): boolean {
  return path.split("/").some((segment) => segment.startsWith("."))
}

function isDirectory(files: Files, path: string): boolean {
  const prefix = path ? `${path}/` : ""
  for (const file of files.keys()) if (file.startsWith(prefix)) return true
  return false
}

function children(files: Files, dir: string): { files: string[]; dirs: string[] } {
  const prefix = dir ? `${dir}/` : ""
  const fileSet = new Set<string>()
  const dirSet = new Set<string>()
  for (const path of files.keys()) {
    if (!path.startsWith(prefix)) continue
    const rest = path.slice(prefix.length)
    const [head, ...tail] = rest.split("/")
    if (!head || head.startsWith(".") || head === "node_modules") continue
    if (tail.length) dirSet.add(`${prefix}${head}`)
    else fileSet.add(`${prefix}${head}`)
  }
  return { files: [...fileSet].sort(), dirs: [...dirSet].sort() }
}

/** Pi reads only array-of-string resource fields; anything else is ignored. */
export function readPiManifest(
  packageJson: Json
): Partial<Record<PiResourceType, string[]>> | null {
  if (!isRecord(packageJson.pi)) return null
  const manifest: Partial<Record<PiResourceType, string[]>> = {}
  for (const field of PI_RESOURCE_TYPES) {
    const entries = packageJson.pi[field]
    if (Array.isArray(entries) && entries.every((entry) => typeof entry === "string"))
      manifest[field] = entries
  }
  return manifest
}

interface DiscoveryContext {
  files: Files
  /** Directories walked; Pi applies ignore files found inside them. */
  walked: Set<string>
}

function collectRecursive(ctx: DiscoveryContext, dir: string, pattern: RegExp): string[] {
  ctx.walked.add(dir)
  const { files, dirs } = children(ctx.files, dir)
  const result = files.filter((path) => pattern.test(basename(path)))
  for (const child of dirs) result.push(...collectRecursive(ctx, child, pattern))
  return result
}

function collectSkillEntries(ctx: DiscoveryContext, dir: string, root: string): string[] {
  ctx.walked.add(dir)
  const skillFile = dir ? `${dir}/SKILL.md` : "SKILL.md"
  if (ctx.files.has(skillFile)) return [skillFile]
  const { files, dirs } = children(ctx.files, dir)
  const result: string[] = []
  if (dir === root) result.push(...files.filter((path) => path.endsWith(".md")))
  for (const child of dirs) result.push(...collectSkillEntries(ctx, child, root))
  return result
}

function resolveExtensionEntries(ctx: DiscoveryContext, dir: string): string[] | null {
  const packageJsonPath = dir ? `${dir}/package.json` : "package.json"
  const text = ctx.files.get(packageJsonPath)
  if (text) {
    try {
      const nested = JSON.parse(text) as unknown
      const manifest = isRecord(nested) ? readPiManifest(nested) : null
      const entries = (manifest?.extensions ?? [])
        .map((entry) => stripDot(dir ? `${dir}/${stripDot(entry)}` : entry))
        .filter((entry) => ctx.files.has(entry) || isDirectory(ctx.files, entry))
      if (entries.length) return entries
    } catch {
      // Pi ignores an unreadable nested manifest and falls back to index files.
    }
  }
  for (const index of ["index.ts", "index.js"]) {
    const path = dir ? `${dir}/${index}` : index
    if (ctx.files.has(path)) return [path]
  }
  return null
}

function collectExtensionEntries(ctx: DiscoveryContext, dir: string): string[] {
  ctx.walked.add(dir)
  const own = resolveExtensionEntries(ctx, dir)
  if (own) return own
  const { files, dirs } = children(ctx.files, dir)
  const result = files.filter((path) => /\.(?:ts|js)$/.test(path))
  for (const child of dirs) result.push(...(resolveExtensionEntries(ctx, child) ?? []))
  return result
}

function collectResourceFiles(ctx: DiscoveryContext, dir: string, type: PiResourceType): string[] {
  if (type === "skills") return collectSkillEntries(ctx, dir, dir)
  if (type === "extensions") return collectExtensionEntries(ctx, dir)
  return collectRecursive(ctx, dir, type === "prompts" ? /\.md$/ : /\.json$/)
}

function isOverride(entry: string): boolean {
  return entry.startsWith("!") || entry.startsWith("+") || entry.startsWith("-")
}

function matchesPattern(path: string, pattern: string): boolean {
  const regex = piGlobToRegExp(stripDot(pattern))
  if (regex.test(path) || regex.test(basename(path))) return true
  if (basename(path) !== "SKILL.md") return false
  const parent = dirname(path)
  return regex.test(parent) || regex.test(basename(parent))
}

function matchesExact(path: string, pattern: string): boolean {
  const normalized = stripDot(pattern)
  return normalized === path || (basename(path) === "SKILL.md" && normalized === dirname(path))
}

function applyOverrides(all: string[], entries: string[]): string[] {
  let result = [...all]
  const excludes = entries.filter((entry) => entry.startsWith("!")).map((entry) => entry.slice(1))
  const force = entries.filter((entry) => entry.startsWith("+")).map((entry) => entry.slice(1))
  const remove = entries.filter((entry) => entry.startsWith("-")).map((entry) => entry.slice(1))
  if (excludes.length)
    result = result.filter((path) => !excludes.some((pattern) => matchesPattern(path, pattern)))
  for (const path of all)
    if (!result.includes(path) && force.some((pattern) => matchesExact(path, pattern)))
      result.push(path)
  if (remove.length)
    result = result.filter((path) => !remove.some((pattern) => matchesExact(path, pattern)))
  return result
}

function expandGlob(files: Files, pattern: string): string[] {
  const regex = piGlobToRegExp(stripDot(pattern))
  const candidates = new Set<string>()
  for (const path of files.keys()) {
    candidates.add(path)
    let parent = dirname(path)
    while (parent) {
      candidates.add(parent)
      parent = dirname(parent)
    }
  }
  return [...candidates].filter((path) => regex.test(path) && !hasDotSegment(path)).sort()
}

export interface PiDiscovery {
  manifest: Partial<Record<PiResourceType, string[]>> | null
  resources: Record<PiResourceType, string[]>
  /** Plain manifest entries that resolve to nothing (Pi skips them). */
  missing: Array<{ type: PiResourceType; entry: string }>
  /** Ignore files inside walked resource directories (Pi applies them). */
  ignoreFiles: string[]
}

/** Resolve the resources Pi loads from a package rooted at the file map root. */
export function discoverPiResources(files: Files, packageJson: Json): PiDiscovery {
  const ctx: DiscoveryContext = { files, walked: new Set() }
  const manifest = readPiManifest(packageJson)
  const resources = { extensions: [], skills: [], prompts: [], themes: [] } as Record<
    PiResourceType,
    string[]
  >
  const missing: PiDiscovery["missing"] = []
  for (const type of PI_RESOURCE_TYPES) {
    if (manifest) {
      const entries = manifest[type]
      if (!entries) continue
      const sources = entries.filter((entry) => !isOverride(entry))
      const resolved: string[] = []
      for (const entry of sources) {
        if (/[*?]/.test(entry)) {
          resolved.push(...expandGlob(files, entry))
          continue
        }
        const path = stripDot(entry)
        if (files.has(path) || isDirectory(files, path)) resolved.push(path)
        else missing.push({ type, entry })
      }
      const all: string[] = []
      for (const path of resolved) {
        if (files.has(path)) all.push(path)
        else all.push(...collectResourceFiles(ctx, path, type))
      }
      resources[type] = [...new Set(applyOverrides([...new Set(all)], entries.filter(isOverride)))]
    } else if (isDirectory(files, type)) {
      resources[type] = collectResourceFiles(ctx, type, type)
    }
  }
  const ignoreFiles = [...files.keys()].filter(
    (path) => IGNORE_FILES.has(basename(path)) && ctx.walked.has(dirname(path))
  )
  return { manifest, resources, missing, ignoreFiles }
}

/** Pi prompt template → explicit-invocation Cognia skill. */
function convertPrompt(
  path: string,
  text: string,
  issues: PiIssues
): { skill: PluginSkillDef; contextual: boolean } | null {
  let parsed: matter.GrayMatterFile<string>
  try {
    parsed = matter(text)
  } catch (error) {
    issue(
      issues,
      "blocking",
      "prompts",
      path,
      error instanceof Error ? error.message : String(error)
    )
    return null
  }
  const unknown = Object.keys(parsed.data).filter(
    (key) => key !== "description" && key !== "argument-hint"
  )
  if (unknown.length) {
    issue(
      issues,
      "blocking",
      "prompts",
      path,
      `Pi prompt frontmatter has no exact Cognia equivalent: ${unknown.join(", ")}`
    )
    return null
  }
  const name = basename(path).replace(/\.md$/i, "")
  const id = slugify(name)
  if (!id) {
    issue(issues, "blocking", "prompts", path, "Prompt file name cannot produce a skill id")
    return null
  }
  if (parsed.data["argument-hint"] !== undefined)
    issue(
      issues,
      "warnings",
      "prompts",
      path,
      "argument-hint only labels the Pi prompt in its UI and was not projected"
    )
  const contextual = /\$(?:\d+|@|ARGUMENTS)|\$\{(?:\d+|@)(?::[^}]*)?\}/.test(parsed.content)
  if (contextual)
    issue(
      issues,
      "warnings",
      "prompts",
      path,
      "converted to an explicit skill; Pi argument placeholders ($1, $@, $ARGUMENTS, ${1:-default}, ${@:N}) stay literal"
    )
  issue(
    issues,
    "converted",
    "prompts",
    path,
    `converted Pi prompt /${name} to explicit skill ${id}`
  )
  return {
    skill: {
      id,
      name,
      description:
        typeof parsed.data.description === "string" ? parsed.data.description.trim() : "",
      invocationPolicy: "explicit",
      source: { kind: "inline", markdown: parsed.content.trim() },
    },
    contextual,
  }
}

function describeExtension(path: string, text: string): string | null {
  if (!text.trim()) return null
  const kinds = new Set<string>()
  for (const match of text.matchAll(/\bregister([A-Z][A-Za-z]*)\s*\(/g)) kinds.add(match[1])
  const events = new Set<string>()
  for (const match of text.matchAll(/\.on\(\s*["'`]([A-Za-z_:.-]+)["'`]/g)) events.add(match[1])
  const parts = [
    ...[...kinds].sort().map((kind) => `register${kind}`),
    ...(events.size ? [`events ${[...events].sort().join(", ")}`] : []),
  ]
  return parts.length ? parts.join("; ") : null
}

export interface PiImportPlan {
  packageJson: Json
  /** Metadata for the Cognia identity. */
  metadata: Json
  /** SKILL.md (or Pi flat `.md`) files Pi loads, as plugin-relative paths. */
  skillFiles: string[]
  /** Prompts converted to explicit skills. */
  promptSkills: PluginSkillDef[]
  piPackage: PluginPiPackageDef
  contextual: boolean
  issues: PiIssues
}

/** Plan a Pi package import. Pure; reports every Pi-only resource. */
export function planPiImport(files: Files): PiImportPlan {
  const issues: PiIssues = { converted: [], warnings: [], blocking: [] }
  const text = files.get("package.json")
  if (text === undefined) throw new Error("Pi package.json was not found")
  const parsed = JSON.parse(text) as unknown
  if (!isRecord(parsed)) throw new Error("package.json must contain a JSON object")
  const packageJson = parsed
  const name = typeof packageJson.name === "string" ? packageJson.name.trim() : ""
  if (!name) throw new Error("package.json.name is required for a Pi package")

  if (packageJson.pi !== undefined && !isRecord(packageJson.pi))
    issue(
      issues,
      "warnings",
      "pi-package",
      "package.json.pi",
      "Pi ignores a non-object pi manifest"
    )
  if (isRecord(packageJson.pi)) {
    for (const [key, value] of Object.entries(packageJson.pi)) {
      if ((PI_RESOURCE_TYPES as readonly string[]).includes(key)) {
        if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string"))
          issue(
            issues,
            "warnings",
            "pi-package",
            `package.json.pi.${key}`,
            "Pi ignores resource fields that are not arrays of strings"
          )
      } else
        issue(
          issues,
          "warnings",
          "pi-package",
          `package.json.pi.${key}`,
          key === "image" || key === "video"
            ? "Pi gallery media is presentation only and was not projected"
            : "Pi does not read this manifest key"
        )
    }
  }

  const discovery = discoverPiResources(files, packageJson)
  for (const { type, entry } of discovery.missing)
    issue(
      issues,
      "warnings",
      "pi-package",
      `package.json.pi.${type}`,
      `Manifest entry ${JSON.stringify(entry)} resolves to nothing; Pi skips it`
    )
  for (const path of discovery.ignoreFiles)
    issue(
      issues,
      "blocking",
      "pi-package",
      path,
      "Pi applies this ignore file during resource discovery; conversion does not evaluate ignore rules and could select resources Pi skips"
    )

  // Collisions with the files Cognia generates next to a retained package.
  const extensionEntries = discovery.resources.extensions
  if (files.has("dist/index.js") || extensionEntries.includes("dist/index.js"))
    issue(
      issues,
      "blocking",
      "pi-package",
      "dist/index.js",
      "The package already uses dist/index.js, which the Cognia plugin entry would overwrite; move the extension build output"
    )
  const declaredExtensions = discovery.manifest?.extensions ?? []
  if (declaredExtensions.some((entry) => /^(?:\.\/)?dist(?:\/|$)/.test(entry)))
    issue(
      issues,
      "blocking",
      "pi-package",
      "package.json.pi.extensions",
      "Extensions load from dist/, which plugin snapshots skip and the Cognia entry overwrites; ship sources or another output directory"
    )

  const skillFiles = discovery.resources.skills.filter((path) => path.endsWith(".md"))

  let contextual = false
  const promptSkills: PluginSkillDef[] = []
  for (const path of discovery.resources.prompts) {
    const prompt = convertPrompt(path, files.get(path) ?? "", issues)
    if (!prompt) continue
    contextual ||= prompt.contextual
    promptSkills.push(prompt.skill)
  }

  for (const path of extensionEntries) {
    const description = describeExtension(path, files.get(path) ?? "")
    issue(
      issues,
      "warnings",
      "pi-package",
      path,
      description
        ? `Pi extension (${description}) is retained for Pi only; its tools, MCP servers and event handlers are not translated into Cognia tools`
        : "Pi extension is retained for Pi only; extension code is not translated into Cognia tools"
    )
  }
  if (extensionEntries.length)
    issue(
      issues,
      "warnings",
      "pi-package",
      "piPackages",
      "No hostedSession block was generated: loading this package into Cognia-hosted Pi sessions needs reviewed hostedSession.extensions/tools declarations written by the author"
    )
  for (const path of discovery.resources.themes)
    issue(issues, "converted", "pi-package", path, "Pi theme retained for Pi only")

  const dependencies = isRecord(packageJson.dependencies) ? packageJson.dependencies : {}
  for (const host of PI_HOST_PACKAGES)
    if (host in dependencies)
      issue(
        issues,
        "warnings",
        "pi-package",
        `package.json.dependencies.${host}`,
        `${host} is provided by Pi; list it in peerDependencies with "*" instead of bundling it`
      )
  const scripts = isRecord(packageJson.scripts) ? packageJson.scripts : {}
  for (const script of LIFECYCLE_SCRIPTS)
    if (typeof scripts[script] === "string")
      issue(
        issues,
        "warnings",
        "pi-package",
        `package.json.scripts.${script}`,
        "Lifecycle scripts never run: Cognia prepares dependencies with npm --ignore-scripts"
      )

  const peer = isRecord(packageJson.peerDependencies)
    ? packageJson.peerDependencies["@earendil-works/pi-coding-agent"]
    : undefined
  const minPiVersion =
    typeof peer === "string" ? /^(?:\^|~|>=)?\s*(\d+\.\d+\.\d+)$/.exec(peer.trim())?.[1] : undefined
  const piPackage: PluginPiPackageDef = {
    id: slugify(name) || PI_PACKAGE_ID_FALLBACK,
    name,
    ...(typeof packageJson.description === "string" && packageJson.description.trim()
      ? { description: packageJson.description.trim() }
      : {}),
    path: ".",
    ...(minPiVersion ? { minPiVersion } : {}),
    ...(Object.keys(dependencies).length
      ? {
          prepare: {
            program: "npm" as const,
            args: [...PI_PREPARE_ARGS],
            marker: "node_modules/.package-lock.json",
          },
        }
      : {}),
  }
  issue(
    issues,
    "converted",
    "pi-package",
    "package.json",
    `retained the complete Pi package as piPackages.${piPackage.id}`
  )

  return {
    packageJson,
    metadata: {
      name,
      version: packageJson.version,
      description: packageJson.description,
      author: packageJson.author,
      license: packageJson.license,
      homepage: packageJson.homepage,
      repository: isRecord(packageJson.repository)
        ? packageJson.repository.url
        : packageJson.repository,
      keywords: packageJson.keywords,
    },
    skillFiles,
    promptSkills,
    piPackage,
    contextual,
    issues,
  }
}

/** Files of a plugin-relative package directory, re-rooted at the package. */
export function packageFiles(files: Files, packagePath: string): Map<string, string> {
  const root = stripDot(packagePath === "." ? "" : packagePath)
  const prefix = root ? `${root}/` : ""
  const result = new Map<string, string>()
  for (const [path, text] of files)
    if (path.startsWith(prefix)) result.set(path.slice(prefix.length), text)
  return result
}

function skillBody(text: string): string {
  try {
    return matter(text).content.trim()
  } catch {
    return text.trim()
  }
}

/**
 * Which Cognia skills a retained package already delivers to Pi. A skill
 * whose id matches a package skill or prompt but whose text differs is a
 * collision, not a duplicate: exporting it would shadow the package's own.
 */
export function classifySkillsForPiPackage(args: {
  skills: PluginSkillDef[]
  files: Files
  piPackage: PluginPiPackageDef
}): { remaining: PluginSkillDef[]; delivered: string[]; collisions: PiIssue[] } {
  const root = stripDot(args.piPackage.path === "." ? "" : args.piPackage.path)
  const pkgFiles = packageFiles(args.files, args.piPackage.path)
  const packageJson = (() => {
    try {
      const value = JSON.parse(pkgFiles.get("package.json") ?? "{}") as unknown
      return isRecord(value) ? value : {}
    } catch {
      return {}
    }
  })()
  const discovery = discoverPiResources(pkgFiles, packageJson)
  const byId = new Map<string, { path: string; body: string }>()
  for (const path of discovery.resources.skills) {
    const text = pkgFiles.get(path) ?? ""
    let name =
      basename(path) === "SKILL.md" ? basename(dirname(path)) : basename(path).replace(/\.md$/, "")
    try {
      const declared = matter(text).data.name
      if (typeof declared === "string" && declared.trim()) name = declared
    } catch {
      // Unparseable frontmatter keeps the directory name.
    }
    byId.set(slugify(name), { path, body: skillBody(text) })
  }
  for (const path of discovery.resources.prompts)
    byId.set(slugify(basename(path).replace(/\.md$/, "")), {
      path,
      body: skillBody(pkgFiles.get(path) ?? ""),
    })
  const remaining: PluginSkillDef[] = []
  const delivered: string[] = []
  const collisions: PiIssue[] = []
  for (const skill of args.skills) {
    const source = skill.source
    if (source.kind === "local-bundle" || source.kind === "local-folder") {
      const dir = stripDot(source.path === "." ? "" : source.path)
      const relative = root ? (dir.startsWith(`${root}/`) ? dir.slice(root.length + 1) : null) : dir
      if (relative !== null) {
        const skillFile = relative ? `${relative}/SKILL.md` : "SKILL.md"
        if (discovery.resources.skills.includes(skillFile)) {
          delivered.push(skill.id)
          continue
        }
      }
    }
    const match = byId.get(skill.id)
    if (match && source.kind === "inline") {
      if (source.markdown.trim() === match.body) {
        delivered.push(skill.id)
        continue
      }
      collisions.push({
        capability: "skills",
        path: `skills.${skill.id}`,
        message: `Skill ${skill.id} differs from the package's ${match.path}; exporting both would shadow one in Pi`,
        blocking: true,
      })
      continue
    }
    if (match) {
      collisions.push({
        capability: "skills",
        path: `skills.${skill.id}`,
        message: `Skill ${skill.id} collides with the package's ${match.path}`,
        blocking: true,
      })
      continue
    }
    remaining.push(skill)
  }
  return { remaining, delivered, collisions }
}

/** Files Cognia generates around a retained package; never part of the Pi package. */
function isCogniaGenerated(path: string, text: string, generatedEntry: string): boolean {
  return path === "plugin.json" || (path === "dist/index.js" && text === generatedEntry)
}

export interface PiExportPlan {
  files: Map<string, string>
  copies: Array<{ from: string; to: string }>
  issues: PiIssues
}

/**
 * Assemble the Pi package for a Cognia plugin. `exported` holds the skill
 * files the Cognia exporter wrote (`skills/<id>/…`) for skills the retained
 * package does not already deliver.
 */
export function planPiExport(args: {
  manifest: PluginManifest
  files: Files
  exported: Map<string, string>
  exportedCopies: Array<{ from: string; to: string }>
  binaryPaths?: ReadonlySet<string>
  generatedEntry: string
}): PiExportPlan {
  const issues: PiIssues = { converted: [], warnings: [], blocking: [] }
  const { manifest } = args
  const packages = manifest.piPackages ?? []
  const files = new Map<string, string>()
  const copies: Array<{ from: string; to: string }> = []
  if (packages.length > 1) {
    issue(
      issues,
      "blocking",
      "pi-package",
      "piPackages",
      "A Pi package has exactly one root; split the plugin's Pi packages before exporting"
    )
    return { files, copies, issues }
  }
  const def = packages[0]
  let packageJson: Json
  if (def) {
    const root = stripDot(def.path === "." ? "" : def.path)
    const prefix = root ? `${root}/` : ""
    for (const [path, text] of args.files) {
      if (!path.startsWith(prefix)) continue
      const relative = path.slice(prefix.length)
      if (!root && isCogniaGenerated(relative, text, args.generatedEntry)) continue
      if (/(^|\/)\.env(?:\.|$)/.test(relative)) continue
      if (args.binaryPaths?.has(path)) copies.push({ from: path, to: relative })
      else files.set(relative, text)
    }
    const text = files.get("package.json")
    if (text === undefined) {
      issue(
        issues,
        "blocking",
        "pi-package",
        `${def.path}/package.json`,
        "Pi package.json is missing"
      )
      return { files, copies, issues }
    }
    const parsed = JSON.parse(text) as unknown
    if (!isRecord(parsed)) {
      issue(issues, "blocking", "pi-package", "package.json", "package.json must contain an object")
      return { files, copies, issues }
    }
    packageJson = { ...parsed }
    if (typeof packageJson.name !== "string" || !packageJson.name.trim())
      packageJson.name = manifest.id
    if (def.prepare)
      issue(
        issues,
        "warnings",
        "pi-package",
        `piPackages.${def.id}.prepare`,
        "Pi installs dependencies for npm and git sources only; a local `pi install` of this directory needs the dependency step run first"
      )
    if (def.hostedSession)
      issue(
        issues,
        "warnings",
        "pi-package",
        `piPackages.${def.id}.hostedSession`,
        "hostedSession declarations configure Cognia-hosted Pi sessions and are not part of the Pi package"
      )
    issue(
      issues,
      "converted",
      "pi-package",
      `piPackages.${def.id}`,
      `exported Pi package ${def.id}`
    )
  } else {
    packageJson = {
      name: manifest.id,
      version: manifest.version,
      ...(manifest.description ? { description: manifest.description } : {}),
      ...(manifest.author ? { author: { ...manifest.author } } : {}),
      ...(manifest.license ? { license: manifest.license } : {}),
      ...(manifest.homepage ? { homepage: manifest.homepage } : {}),
      ...(manifest.repository ? { repository: manifest.repository } : {}),
      keywords: [...(manifest.keywords ?? [])],
      pi: { skills: ["./skills"] },
    }
  }

  const keywords = Array.isArray(packageJson.keywords)
    ? packageJson.keywords.filter((keyword): keyword is string => typeof keyword === "string")
    : []
  if (!keywords.includes("pi-package")) keywords.push("pi-package")
  packageJson.keywords = keywords

  const dependencies = isRecord(packageJson.dependencies) ? packageJson.dependencies : {}
  for (const host of PI_HOST_PACKAGES)
    if (host in dependencies)
      issue(
        issues,
        "blocking",
        "pi-package",
        `package.json.dependencies.${host}`,
        `${host} must be a peerDependency ("*"); Pi refuses to load a bundled copy of its own host packages`
      )

  for (const [path, text] of args.exported) {
    if (files.has(path) && files.get(path) !== text) {
      issue(
        issues,
        "blocking",
        "skills",
        path,
        "An exported skill file would overwrite a different file in the Pi package"
      )
      continue
    }
    files.set(path, text)
  }
  for (const copy of args.exportedCopies) copies.push(copy)

  // Make Pi actually load the exported skills: a package with a `pi` manifest
  // reads only the listed entries; without one, skills/ is conventional.
  const exportedSkillDirs = [
    ...new Set(
      [...args.exported.keys(), ...args.exportedCopies.map((copy) => copy.to)]
        .filter((path) => /^skills\/[^/]+\/SKILL\.md$/.test(path))
        .map((path) => dirname(path))
    ),
  ]
  if (exportedSkillDirs.length && isRecord(packageJson.pi)) {
    const pi = { ...packageJson.pi }
    const skills = Array.isArray(pi.skills)
      ? pi.skills.filter((entry): entry is string => typeof entry === "string")
      : []
    const probe = new Map(files)
    for (const copy of copies) probe.set(copy.to, "")
    const loaded = discoverPiResources(probe, { ...packageJson, pi }).resources.skills
    for (const dir of exportedSkillDirs)
      if (!loaded.includes(`${dir}/SKILL.md`)) skills.push(`./${dir}`)
    pi.skills = skills
    packageJson.pi = pi
  }
  files.set("package.json", `${JSON.stringify(packageJson, null, 2)}\n`)
  const probe = new Map(files)
  for (const copy of copies) probe.set(copy.to, "")
  const finalSkills = discoverPiResources(probe, packageJson).resources.skills
  for (const dir of exportedSkillDirs)
    if (!finalSkills.includes(`${dir}/SKILL.md`))
      issue(
        issues,
        "blocking",
        "skills",
        `${dir}/SKILL.md`,
        "Pi would not discover this exported skill with the package's resource rules"
      )
  return { files, copies, issues }
}
