/**
 * Discover skills from disk in the Claude-Code `SKILL.md` convention and import
 * them into the CLI-local Dexie so the standalone CLI gains the same skills
 * support the desktop has (where a Rust sync pipeline installs disk skills).
 *
 * Layout, mirroring `.claude/skills/`:
 *   - `<dir>/<name>/SKILL.md`  (folder skill — can bundle resources alongside)
 *   - `<dir>/<name>.md`        (flat skill)
 * Project skills (`<cwd>/.cognia/skills`) override global ones
 * (`<home>/skills`) on an id collision — the first directory wins.
 *
 * Discovery is pure + fs-injected (tests pass an in-memory fs); the seeding step
 * reuses the desktop's `upsertSkillByCanonicalId`, keyed by a stable
 * `cli-disk:<source>:<id>` canonical id so re-running on every launch UPDATES
 * rather than duplicates, and an edited SKILL.md is picked up.
 */
import nodeFs from "node:fs/promises"
import path from "node:path"

import { parseSkillMarkdown, nameFromFilename } from "@/lib/claude/skills-io"

/** The minimal fs surface discovery needs (matches `AgentFs`). */
export interface SkillFs {
  exists(path: string): Promise<boolean>
  readDir(path: string): Promise<string[]>
  readText(path: string): Promise<string>
  isDirectory(path: string): Promise<boolean>
}

const defaultFs: SkillFs = {
  async exists(p) {
    try {
      await nodeFs.access(p)
      return true
    } catch {
      return false
    }
  },
  async readDir(p) {
    try {
      return await nodeFs.readdir(p)
    } catch {
      return []
    }
  },
  readText: (p) => nodeFs.readFile(p, "utf8"),
  async isDirectory(p) {
    try {
      return (await nodeFs.stat(p)).isDirectory()
    } catch {
      return false
    }
  },
}

export type SkillSourceKind = "project" | "global"

/** One skill directory to scan, tagged with where it came from. */
export interface SkillScanDir {
  dir: string
  source: SkillSourceKind
}

export interface DiscoveredSkill {
  /** Stable canonical id for idempotent upsert (`cli-disk:<source>:<id>`). */
  canonicalId: string
  /** Bare id derived from the folder/file name (kebab). */
  id: string
  source: SkillSourceKind
  draft: ReturnType<typeof parseSkillMarkdown>["draft"]
  warnings: string[]
  /** Absolute path to the SKILL.md / flat `*.md` this skill was parsed from. */
  filePath: string
  /** Skill root directory for folder skills (holds bundled references/scripts);
   * `undefined` for flat `*.md` skills, which bundle nothing. */
  dir?: string
}

function idFromName(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/\.(md|markdown)$/i, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "skill"
  )
}

/**
 * Scan each directory for SKILL.md folders and flat `*.md` skills, parse them,
 * and return the discovered skills. Project dirs (passed first) win over global
 * ones on an id collision. Unreadable / unparseable files are skipped (their
 * id is still claimed so a broken project skill doesn't fall through to a global
 * one with the same id).
 */
export async function discoverDiskSkills(
  dirs: SkillScanDir[],
  fs: SkillFs = defaultFs
): Promise<DiscoveredSkill[]> {
  const byId = new Map<string, DiscoveredSkill>()
  const claimed = new Set<string>()

  for (const { dir, source } of dirs) {
    if (!(await fs.exists(dir))) continue
    for (const entry of await fs.readDir(dir)) {
      const full = path.join(dir, entry)
      let filePath: string | null = null
      let skillDir: string | undefined
      let fallback = entry
      if (await fs.isDirectory(full)) {
        const skillMd = path.join(full, "SKILL.md")
        if (await fs.exists(skillMd)) {
          filePath = skillMd
          skillDir = full
          fallback = entry
        }
      } else if (/\.(md|markdown)$/i.test(entry)) {
        filePath = full
        fallback = nameFromFilename(entry)
      }
      if (!filePath) continue

      const id = idFromName(entry)
      if (claimed.has(id)) continue
      claimed.add(id)

      try {
        const text = await fs.readText(filePath)
        const { draft, warnings } = parseSkillMarkdown(text, { fallbackName: fallback })
        byId.set(id, {
          canonicalId: `cli-disk:${source}:${id}`,
          id,
          source,
          draft: { ...draft, source: "imported" },
          warnings,
          filePath,
          ...(skillDir ? { dir: skillDir } : {}),
        })
      } catch {
        // unreadable / no name / empty body — skip, but the id stays claimed.
      }
    }
  }
  return [...byId.values()]
}

/** Project + global skill directories for a cwd / home pair. */
export function skillScanDirs(cwd: string, home: string): SkillScanDir[] {
  return [
    { dir: path.join(cwd, ".cognia", "skills"), source: "project" },
    { dir: path.join(home, "skills"), source: "global" },
  ]
}

/**
 * Find a disk skill by its canonical id (`cli-disk:<source>:<id>`), re-running
 * discovery against the project + global skill dirs. Returns the discovered
 * record (with `dir` / `filePath`) or `undefined` when the id isn't an on-disk
 * skill (e.g. a built-in seeded into Dexie with a different canonical id).
 */
export async function findDiskSkillByCanonicalId(
  cwd: string,
  home: string,
  canonicalId: string,
  fs: SkillFs = defaultFs
): Promise<DiscoveredSkill | undefined> {
  const all = await discoverDiskSkills(skillScanDirs(cwd, home), fs)
  return all.find((s) => s.canonicalId === canonicalId)
}

/** One bundled file inside a skill directory. */
export interface SkillBundledFile {
  /** Path relative to the skill root (POSIX-style separators for display). */
  relPath: string
  /** Absolute path on disk (the `/view` target). */
  absPath: string
}

/**
 * List the files bundled inside a folder skill's directory (recursively, depth-
 * capped), sorted with `SKILL.md` first. Used by `/skill files` so the user can
 * open a skill's references / scripts in the viewer.
 */
export async function listSkillBundledFiles(
  dir: string,
  fs: SkillFs = defaultFs,
  maxDepth = 4
): Promise<SkillBundledFile[]> {
  const out: SkillBundledFile[] = []
  async function walk(current: string, depth: number): Promise<void> {
    if (depth > maxDepth) return
    for (const entry of await fs.readDir(current)) {
      const abs = path.join(current, entry)
      if (await fs.isDirectory(abs)) {
        await walk(abs, depth + 1)
      } else {
        out.push({ relPath: path.relative(dir, abs).split(path.sep).join("/"), absPath: abs })
      }
    }
  }
  await walk(dir, 0)
  out.sort((a, b) => {
    if (a.relPath === "SKILL.md") return -1
    if (b.relPath === "SKILL.md") return 1
    return a.relPath.localeCompare(b.relPath)
  })
  return out
}

export interface SeedDiskSkillsResult {
  created: number
  updated: number
}

/**
 * Discover disk skills for the given roots and upsert them into Dexie. Idempotent
 * (canonical-id keyed); safe to call before every `/skill list`. The upsert fn is
 * injected so the discovery↔db wiring is unit-tested without a live Dexie.
 */
export async function seedDiskSkills(
  cwd: string,
  home: string,
  upsert: (input: {
    draft: DiscoveredSkill["draft"]
    canonicalId: string
  }) => Promise<{ created: boolean }>,
  fs: SkillFs = defaultFs
): Promise<SeedDiskSkillsResult> {
  const discovered = await discoverDiskSkills(skillScanDirs(cwd, home), fs)
  let created = 0
  let updated = 0
  for (const s of discovered) {
    try {
      const { created: wasCreated } = await upsert({ draft: s.draft, canonicalId: s.canonicalId })
      if (wasCreated) created++
      else updated++
    } catch {
      // a single bad skill must not abort the rest
    }
  }
  return { created, updated }
}
