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
// Beyond the standard chat-skill fields we read `metadata.surface` — the list of
// agent surfaces this skill auto-activates on (see lib/skills/surface-activation.ts).
//
// Usage:
//   node scripts/build/build-builtin-skills.mjs          # write the catalog
//   node scripts/build/build-builtin-skills.mjs --check   # verify it's up to date

import { existsSync, readFileSync } from "node:fs"
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
const OUT_FILE = path.join(REPO_ROOT, "lib", "skills", "built-in-catalog.generated.ts")

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

  const surface = parseList(fm?.metadata?.surface) ?? []

  const entry = { id, name, content: body, surface }
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
      resources.push({
        kind,
        name: path.basename(relative),
        path: path.posix.join(subdir, relative.split(path.sep).join("/")),
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
      if (resources.length > 0) entry.resources = resources
      return entry
    })
  return entries.sort((a, b) => a.id.localeCompare(b.id))
}

/** Render the catalog as the generated TS module source. Deterministic. */
export function renderCatalogModule(entries) {
  const ordered = ["id", "name", "description", "content", "category", "tags", "allowedTools", "surface"]
  const lines = []
  lines.push("/* eslint-disable */")
  lines.push("// @generated by scripts/build/build-builtin-skills.mjs from skills/built-in/*/SKILL.md")
  lines.push("// Do not edit by hand. Run `pnpm skills:build` to regenerate.")
  lines.push("")
  lines.push("export interface BuiltInSkillResource {")
  lines.push('  kind: "script" | "reference" | "asset"')
  lines.push("  name: string")
  lines.push("  path: string")
  lines.push("  content: string")
  lines.push("}")
  lines.push("")
  lines.push("export interface BuiltInSkillCatalogEntry {")
  lines.push("  id: string")
  lines.push("  name: string")
  lines.push("  description?: string")
  lines.push("  content: string")
  lines.push("  category?: string")
  lines.push("  tags?: string[]")
  lines.push("  allowedTools?: string[]")
  lines.push("  surface: string[]")
  lines.push("  resources?: BuiltInSkillResource[]")
  lines.push("}")
  lines.push("")
  lines.push("export const BUILT_IN_SKILL_CATALOG: BuiltInSkillCatalogEntry[] = [")
  for (const entry of entries) {
    lines.push("  {")
    for (const key of ordered) {
      if (!(key in entry)) continue
      lines.push(`    ${key}: ${JSON.stringify(entry[key])},`)
    }
    if (entry.resources && entry.resources.length > 0) {
      lines.push("    resources: [")
      for (const r of entry.resources) {
        lines.push(`      { kind: ${JSON.stringify(r.kind)}, name: ${JSON.stringify(r.name)}, path: ${JSON.stringify(r.path)}, content: ${JSON.stringify(r.content)} },`)
      }
      lines.push("    ],")
    }
    lines.push("  },")
  }
  lines.push("]")
  lines.push("")
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
  const current = existsSync(OUT_FILE) ? readFileSync(OUT_FILE, "utf8") : ""
  if (options.check) {
    if (current !== next) {
      console.error(
        "built-in skills catalog is out of date. Run `pnpm skills:build` and commit lib/skills/built-in-catalog.generated.ts."
      )
      process.exit(1)
    }
    console.log(`built-in skills catalog up to date (${entries.length} skills).`)
    return
  }
  if (current !== next) {
  writeFileAtomic.sync(OUT_FILE, next)
    console.log(`wrote ${OUT_FILE} (${entries.length} skills).`)
  } else {
    console.log(`built-in skills catalog unchanged (${entries.length} skills).`)
  }
}

if (
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1] === fileURLToPath(import.meta.url)
) {
  main(process.argv.slice(2))
}
