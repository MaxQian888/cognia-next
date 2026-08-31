// Codegen: bundle the hand-authored `skills/built-in/<id>/SKILL.md` files into a
// committed TypeScript catalog the app can import at runtime.
//
// Why a build step: the desktop/web app is a Next.js *static export* with no
// Node fs at runtime, so it can't read SKILL.md off disk the way the CLI can.
// The existing built-in chat skills are inlined as string literals in
// `lib/db/skills.ts` for exactly this reason. Authoring the functional skills as
// real SKILL.md files (so they're skill-creator-editable and reviewable) and
// generating an inline TS catalog from them gives us one human-editable source
// that both shells consume: desktop seeds the catalog into Dexie, the CLI seeds
// the same catalog.
//
// Frontmatter is parsed with gray-matter (same lib as lib/claude/skills-io.ts).
// Beyond the standard chat-skill fields we read the orthogonal delivery,
// trigger, capability-requirement, and host-policy descriptors. Runtime code
// decides what to inject or offer from those facts without reading the filesystem.
//
// Usage:
//   node scripts/build/build-builtin-skills.mjs          # write the catalog
//   node scripts/build/build-builtin-skills.mjs --check   # verify it's up to date

import { existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import { Command, CommanderError } from "commander"
import { globSync } from "glob"
import matter from "gray-matter"
import writeFileAtomic from "write-file-atomic"
import { z } from "zod"

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, "..", "..")
const SKILLS_DIR = path.join(REPO_ROOT, "skills", "built-in")
const GENERATED_DIR = path.join(REPO_ROOT, "generated", "built-in-skills")
const OUT_FILE = path.join(GENERATED_DIR, "built-in-catalog.generated.ts")
const RESOURCE_DIR = path.join(GENERATED_DIR, "resources")
const RESOURCE_LOADER_FILE = path.join(
  GENERATED_DIR,
  "built-in-resource-loader.generated.ts"
)

const VALID_CATEGORIES = new Set([
  "creative-design",
  "development",
  "enterprise",
  "productivity",
  "data-analysis",
  "communication",
  "meta",
  "custom",
])

const VALID_DELIVERY = new Set(["inject", "catalog", "explicit", "request-scoped"])

/** Coerce a YAML array-or-comma-string into a clean string[] (mirrors skills-io parseList). */
function parseList(v) {
  if (Array.isArray(v)) {
    const arr = v.map((x) => (typeof x === "string" ? x.trim() : "")).filter(Boolean)
    return arr.length ? arr : undefined
  }
  if (typeof v === "string") {
    const arr = v
      .split(/[,\n]/)
      .map((s) => s.trim())
      .filter(Boolean)
    return arr.length ? arr : undefined
  }
  return undefined
}

function strOrUndef(v) {
  return typeof v === "string" && v.trim() ? v.trim() : undefined
}

/**
 * Parse one SKILL.md into a catalog entry. `id` is the folder name (kebab).
 * Throws on a missing name or empty body so a broken skill fails the build
 * loudly rather than shipping a half-formed entry.
 */
export function parseSkillFile(id, text) {
  const { data, content } = matter(text)
  const fm = data ?? {}
  const name = strOrUndef(fm.name)
  if (!name) throw new Error(`skill "${id}": missing frontmatter 'name'`)
  const body = content.trim()
  if (!body) throw new Error(`skill "${id}": empty body`)

  const categoryRaw = strOrUndef(fm.category)?.toLowerCase()
  const category = categoryRaw && VALID_CATEGORIES.has(categoryRaw) ? categoryRaw : undefined

  const defaultEnabledRaw = fm?.metadata?.["default-enabled"]
  if (defaultEnabledRaw !== undefined && typeof defaultEnabledRaw !== "boolean") {
    throw new Error(`skill "${id}": metadata.default-enabled must be a boolean`)
  }

  const delivery = strOrUndef(fm?.metadata?.delivery)
  if (!delivery || !VALID_DELIVERY.has(delivery)) {
    throw new Error(
      `skill "${id}": metadata.delivery must be inject, catalog, explicit, or request-scoped`
    )
  }

  const surfaces = parseList(fm?.metadata?.triggers?.surfaces) ?? []
  const intents = parseList(fm?.metadata?.triggers?.intents) ?? []
  if (surfaces.length === 0 && intents.length === 0) {
    throw new Error(`skill "${id}": metadata.triggers must declare a surface or intent fact`)
  }
  if (delivery === "inject" && surfaces.length === 0) {
    throw new Error(`skill "${id}": inject delivery requires at least one surface trigger`)
  }
  if (delivery === "explicit" && surfaces.length > 0) {
    throw new Error(`skill "${id}": explicit delivery cannot declare a surface trigger`)
  }
  if (delivery === "request-scoped" && surfaces.length > 0) {
    throw new Error(`skill "${id}": request-scoped delivery cannot declare a surface trigger`)
  }

  const capabilityRequirementsRaw = fm?.metadata?.["capability-requirements"]
  if (!Array.isArray(capabilityRequirementsRaw)) {
    throw new Error(`skill "${id}": metadata.capability-requirements must be an array`)
  }
  const capabilityRequirements = capabilityRequirementsRaw.map((requirement, index) => {
    if (!requirement || typeof requirement !== "object" || Array.isArray(requirement)) {
      throw new Error(`skill "${id}": capability requirement ${index} must be an object`)
    }
    const capability = strOrUndef(requirement.capability)
    const reason = strOrUndef(requirement.reason)
    const whenIntent = strOrUndef(requirement["when-intent"])
    if (!capability || !reason) {
      throw new Error(
        `skill "${id}": capability requirement ${index} needs capability and reason`
      )
    }
    if (whenIntent && !intents.includes(whenIntent)) {
      throw new Error(
        `skill "${id}": capability requirement ${index} when-intent must name a declared intent`
      )
    }
    return { capability, reason, ...(whenIntent ? { whenIntent } : {}) }
  })

  const hostPolicies = parseList(fm?.metadata?.["host-policies"])
  if (!hostPolicies) {
    throw new Error(`skill "${id}": metadata.host-policies must be a non-empty list`)
  }

  const entry = {
    id,
    canonicalId: `builtin:${id}`,
    name,
    content: body,
    triggers: { surfaces, intents },
    delivery,
    capabilityRequirements,
    hostPolicies,
    // Compatibility projection for the current surface selector. New wiring
    // consumes `triggers.surfaces`; keeping this alias makes the descriptor
    // additive while the runtime migrates.
    surface: surfaces,
  }
  if (defaultEnabledRaw === true) entry.defaultEnabled = true
  const description = strOrUndef(fm.description)
  if (description) entry.description = description
  if (category) entry.category = category
  const tags = parseList(fm.tags)
  if (tags) entry.tags = tags
  const allowedTools = parseList(fm["allowed-tools"]) ?? parseList(fm.allowedTools)
  if (allowedTools) entry.allowedTools = allowedTools
  return entry
}

/** Map a skill's top-level resource directory to a SkillResourceKind. */
const RESOURCE_DIR_KIND = { references: "reference", scripts: "script", assets: "asset" }

/** Resource role is a stable runtime contract, not a guess made by the model. */
export function resourceRole(relativePath) {
  const normalized = relativePath.replaceAll("\\", "/")
  const basename = path.posix.basename(normalized)
  if (/license/i.test(basename)) return "compliance"
  if (/^assets\/template(?:\.|$)/.test(normalized)) return "template"
  if (/^assets\/example-[^/]+/.test(normalized)) return "example"
  return "runtime-reference"
}

/**
 * Collect a folder skill's bundled resources (references/, scripts/, assets/),
 * recursively, as resource drafts. `path` is POSIX-relative to the skill root
 * (e.g. `references/foo.md`); `content` is the file body inlined so the static
 * export can persist it without runtime fs. Sorted by path for determinism.
 */
export function collectResources(skillDir) {
  const resources = []
  for (const [subdir, kind] of Object.entries(RESOURCE_DIR_KIND)) {
    const root = path.join(skillDir, subdir)
    for (const relative of globSync("**/*", { cwd: root, nodir: true }).sort()) {
      const absolute = path.join(root, relative)
      const resourcePath = path.posix.join(subdir, relative.split(path.sep).join("/"))
      resources.push({
        kind,
        role: resourceRole(resourcePath),
        name: path.basename(relative),
        path: resourcePath,
        content: readFileSync(absolute, "utf8"),
      })
    }
  }
  return resources.sort((a, b) => a.path.localeCompare(b.path))
}

/** Discover + parse every `skills/built-in/<id>/SKILL.md`, sorted by id. */
export function buildCatalog(dir = SKILLS_DIR) {
  const entries = globSync("*/SKILL.md", { cwd: dir, nodir: true })
    .sort()
    .map((relative) => {
      const name = relative.split("/")[0]
      const full = path.join(dir, name)
      const entry = parseSkillFile(name, readFileSync(path.join(dir, relative), "utf8"))
      const resources = collectResources(full)
      if (resources.length > 0) {
        entry.resourceManifest = resources.map(({ content: _content, ...descriptor }) => descriptor)
        entry.resources = resources
      }
      return entry
    })
  return entries.sort((a, b) => a.id.localeCompare(b.id))
}

/** Render the catalog as the generated TS module source. Deterministic. */
export function renderCatalogModule(entries) {
  const capabilityIds = [
    ...new Set(
      entries.flatMap((entry) =>
        entry.capabilityRequirements.map((requirement) => requirement.capability)
      )
    ),
  ].sort()
  const ordered = [
    "id",
    "canonicalId",
    "name",
    "description",
    "content",
    "category",
    "tags",
    "allowedTools",
    "triggers",
    "delivery",
    "capabilityRequirements",
    "hostPolicies",
    "surface",
    "defaultEnabled",
  ]
  const lines = []
  lines.push("/* eslint-disable */")
  lines.push("// @generated by scripts/build/build-builtin-skills.mjs from skills/built-in/*/SKILL.md")
  lines.push("// Do not edit by hand. Run `pnpm skills:build` to regenerate.")
  lines.push("")
  lines.push("export interface BuiltInSkillResource {")
  lines.push('  kind: "script" | "reference" | "asset"')
  lines.push('  role: "runtime-reference" | "template" | "example" | "compliance"')
  lines.push("  name: string")
  lines.push("  path: string")
  lines.push("  content: string")
  lines.push("}")
  lines.push("")
  lines.push("export type BuiltInSkillResourceDescriptor = Omit<BuiltInSkillResource, \"content\">")
  lines.push("")
  lines.push('export type BuiltInSkillDelivery = "inject" | "catalog" | "explicit" | "request-scoped"')
  lines.push("")
  lines.push(
    `export const BUILT_IN_SKILL_CAPABILITY_IDS = ${JSON.stringify(capabilityIds)} as const`
  )
  lines.push(
    "export type BuiltInSkillCapabilityId = (typeof BUILT_IN_SKILL_CAPABILITY_IDS)[number]"
  )
  lines.push("")
  lines.push("export interface BuiltInSkillTriggerFacts {")
  lines.push("  surfaces: string[]")
  lines.push("  intents: string[]")
  lines.push("}")
  lines.push("")
  lines.push("export interface BuiltInSkillCapabilityRequirement {")
  lines.push("  capability: BuiltInSkillCapabilityId")
  lines.push("  reason: string")
  lines.push("  whenIntent?: string")
  lines.push("}")
  lines.push("")
  lines.push("export interface BuiltInSkillCatalogEntry {")
  lines.push("  id: string")
  lines.push("  canonicalId: string")
  lines.push("  name: string")
  lines.push("  description?: string")
  lines.push("  content: string")
  lines.push("  category?: string")
  lines.push("  tags?: string[]")
  lines.push("  allowedTools?: string[]")
  lines.push("  triggers: BuiltInSkillTriggerFacts")
  lines.push("  delivery: BuiltInSkillDelivery")
  lines.push("  capabilityRequirements: BuiltInSkillCapabilityRequirement[]")
  lines.push("  hostPolicies: string[]")
  lines.push("  surface: string[]")
  lines.push("  defaultEnabled?: boolean")
  lines.push("  resourceManifest?: BuiltInSkillResourceDescriptor[]")
  lines.push("}")
  lines.push("")
  lines.push("export const BUILT_IN_SKILL_CATALOG: BuiltInSkillCatalogEntry[] = [")
  for (const entry of entries) {
    lines.push("  {")
    for (const key of ordered) {
      if (!(key in entry)) continue
      lines.push(`    ${key}: ${JSON.stringify(entry[key])},`)
    }
    if (entry.resourceManifest && entry.resourceManifest.length > 0) {
      lines.push(`    resourceManifest: ${JSON.stringify(entry.resourceManifest)},`)
    }
    lines.push("  },")
  }
  lines.push("]")
  lines.push("")
  return lines.join("\n")
}

/** Render one independently-lazy resource payload chunk. */
export function renderResourceModule(entry) {
  const lines = [
    "/* eslint-disable */",
    `// @generated resource payload for ${entry.id}`,
    '// Do not edit by hand. Run `pnpm skills:build` to regenerate.',
    "",
    'import type { BuiltInSkillResource } from "../built-in-catalog.generated"',
    "",
    "export const BUILT_IN_SKILL_RESOURCES: BuiltInSkillResource[] = [",
  ]
  for (const resource of entry.resources ?? []) {
    lines.push(
      `  { kind: ${JSON.stringify(resource.kind)}, role: ${JSON.stringify(resource.role)}, name: ${JSON.stringify(resource.name)}, path: ${JSON.stringify(resource.path)}, content: ${JSON.stringify(resource.content)} },`
    )
  }
  lines.push("]", "")
  return lines.join("\n")
}

/** Render the small static-import switch that lets bundlers split per Skill. */
export function renderResourceLoaderModule(entries) {
  const withResources = entries.filter((entry) => (entry.resources?.length ?? 0) > 0)
  const lines = [
    "/* eslint-disable */",
    "// @generated by scripts/build/build-builtin-skills.mjs",
    '// Do not edit by hand. Run `pnpm skills:build` to regenerate.',
    "",
    'import type { BuiltInSkillResource } from "./built-in-catalog.generated"',
    "",
    "export async function loadBuiltInSkillResourcePayload(",
    "  bundleId: string",
    "): Promise<BuiltInSkillResource[]> {",
    "  switch (bundleId) {",
  ]
  for (const entry of withResources) {
    lines.push(
      `    case ${JSON.stringify(entry.id)}:`,
      `      return (await import("./resources/${entry.id}.generated")).BUILT_IN_SKILL_RESOURCES`
    )
  }
  lines.push("    default:", "      return []", "  }", "}", "")
  return lines.join("\n")
}

const cliSchema = z.object({ check: z.boolean().default(false) })

function createProgram() {
  return new Command()
    .name("pnpm skills:build")
    .description("Build or verify the static built-in skill catalog.")
    .configureOutput({ writeErr: () => {} })
    .showHelpAfterError()
    .exitOverride()
    .option("--check", "Verify the generated catalog without writing it.")
}

export function parseArgs(argv) {
  const program = createProgram()
  try {
    program.parse(argv, { from: "user" })
  } catch (error) {
    if (error instanceof CommanderError && error.code === "commander.helpDisplayed") return null
    throw error
  }
  return cliSchema.parse(program.opts())
}

function main(argv) {
  const options = parseArgs(argv)
  if (!options) return
  const entries = buildCatalog()
  const next = renderCatalogModule(entries)
  const resourceLoader = renderResourceLoaderModule(entries)
  const resourceOutputs = new Map(
    entries
      .filter((entry) => (entry.resources?.length ?? 0) > 0)
      .map((entry) => [
        path.join(RESOURCE_DIR, `${entry.id}.generated.ts`),
        renderResourceModule(entry),
      ])
  )
  const current = existsSync(OUT_FILE) ? readFileSync(OUT_FILE, "utf8") : ""
  if (options.check) {
    const loaderCurrent = existsSync(RESOURCE_LOADER_FILE)
      ? readFileSync(RESOURCE_LOADER_FILE, "utf8")
      : ""
    const payloadsCurrent = [...resourceOutputs].every(
      ([file, source]) => existsSync(file) && readFileSync(file, "utf8") === source
    )
    const stalePayloads = globSync("*.generated.ts", { cwd: RESOURCE_DIR, nodir: true }).filter(
      (name) => !resourceOutputs.has(path.join(RESOURCE_DIR, name))
    )
    if (
      current !== next ||
      loaderCurrent !== resourceLoader ||
      !payloadsCurrent ||
      stalePayloads.length > 0
    ) {
      console.error(
        "built-in skills catalog/resources are out of date. Run `pnpm skills:build` and commit the generated outputs."
      )
      process.exit(1)
    }
    console.log(`built-in skills catalog up to date (${entries.length} skills).`)
    return
  }
  if (current !== next) {
    mkdirSync(GENERATED_DIR, { recursive: true })
    writeFileAtomic.sync(OUT_FILE, next)
    console.log(`wrote ${OUT_FILE} (${entries.length} skills).`)
  } else {
    console.log(`built-in skills catalog unchanged (${entries.length} skills).`)
  }
  mkdirSync(RESOURCE_DIR, { recursive: true })
  if (
    !existsSync(RESOURCE_LOADER_FILE) ||
    readFileSync(RESOURCE_LOADER_FILE, "utf8") !== resourceLoader
  ) {
    writeFileAtomic.sync(RESOURCE_LOADER_FILE, resourceLoader)
  }
  for (const [file, source] of resourceOutputs) {
    if (!existsSync(file) || readFileSync(file, "utf8") !== source) {
      writeFileAtomic.sync(file, source)
    }
  }
  for (const stale of globSync("*.generated.ts", { cwd: RESOURCE_DIR, nodir: true })) {
    const file = path.join(RESOURCE_DIR, stale)
    if (!resourceOutputs.has(file)) unlinkSync(file)
  }
}

if (
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1] === fileURLToPath(import.meta.url)
) {
  main(process.argv.slice(2))
}
