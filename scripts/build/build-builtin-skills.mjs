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

import { readFileSync, readdirSync, existsSync, writeFileSync, statSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

import matter from "gray-matter"

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
    if (!existsSync(root) || !statSync(root).isDirectory()) continue
    const walk = (current) => {
      for (const entry of readdirSync(current).sort()) {
        const abs = path.join(current, entry)
        if (statSync(abs).isDirectory()) {
          walk(abs)
        } else {
          const rel = path.relative(skillDir, abs).split(path.sep).join("/")
          resources.push({ kind, name: entry, path: rel, content: readFileSync(abs, "utf8") })
        }
      }
    }
    walk(root)
  }
  return resources.sort((a, b) => a.path.localeCompare(b.path))
}

/** Discover + parse every `skills/built-in/<id>/SKILL.md`, sorted by id. */
export function buildCatalog(dir = SKILLS_DIR) {
  if (!existsSync(dir)) return []
  const entries = []
  for (const name of readdirSync(dir).sort()) {
    const full = path.join(dir, name)
    if (!statSync(full).isDirectory()) continue
    const skillMd = path.join(full, "SKILL.md")
    if (!existsSync(skillMd)) continue
    const entry = parseSkillFile(name, readFileSync(skillMd, "utf8"))
    const resources = collectResources(full)
    if (resources.length > 0) entry.resources = resources
    entries.push(entry)
  }
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

function main() {
  const check = process.argv.includes("--check")
  const entries = buildCatalog()
  const next = renderCatalogModule(entries)
  const current = existsSync(OUT_FILE) ? readFileSync(OUT_FILE, "utf8") : ""
  if (check) {
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
    writeFileSync(OUT_FILE, next)
    console.log(`wrote ${OUT_FILE} (${entries.length} skills).`)
  } else {
    console.log(`built-in skills catalog unchanged (${entries.length} skills).`)
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1] === fileURLToPath(import.meta.url)) {
  main()
}
