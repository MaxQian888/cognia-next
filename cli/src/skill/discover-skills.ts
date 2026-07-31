/**
 * Discover skills from disk in the Claude-Code `SKILL.md` convention and import
 * them into the CLI-local Dexie so the standalone CLI gains the same skills
 * support the desktop has (where a Rust sync pipeline installs disk skills).
 *
 * Layout, mirroring `.claude/skills/`:
 *   - `<dir>/<name>/SKILL.md`  (folder skill — can bundle resources alongside)
 *   - `<dir>/<name>.md`        (flat skill)
 *
 * Beyond the CLI's own `.cognia/skills` dirs, discovery also reuses the skill
 * directories other agents write — Claude Code (`~/.claude/skills`, project
 * `<cwd>/.claude/skills`) and Codex (`~/.agents/skills`) — plus any extra
 * directories the user configures (`config.skillDirs`). This mirrors the
 * desktop's native sync, which already scans `~/.claude/skills` /
 * `~/.agents/skills` via Rust. The first directory wins on an id collision, so
 * a project skill overrides a global one and the CLI's own dirs win over the
 * reused external ones.
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

/**
 * Where a discovered skill came from. The CLI's own dirs (`project` / `global`,
 * under `.cognia/skills`) plus the reused external agent dirs:
 *   - `claude-project` — `<cwd>/.claude/skills`
 *   - `claude`         — `<osHome>/.claude/skills` (Claude Code global)
 *   - `codex`          — `<osHome>/.agents/skills` (Codex global)
 *   - `opencode`       — `<osHome>/.opencode/skills` (OpenCode global)
 *   - `custom`         — a user-configured `config.skillDirs` entry
 */
export type SkillSourceKind =
  "project" | "global" | "claude-project" | "claude" | "codex" | "opencode" | "custom"

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

/** Inputs to {@link skillScanDirs}. Beyond the CLI's own `.cognia` dirs, the
 * scan reuses other agents' skill directories (Claude Code / Codex) and any
 * user-configured extra dirs, unless `external` is `false`. */
export interface SkillScanOptions {
  /** Working directory — its `.cognia/skills` + `.claude/skills` are scanned. */
  cwd: string
  /** CLI home (`~/.cognia`) — its `skills/` is the global CLI skill dir. */
  home: string
  /** OS home (`~`). Claude Code / Codex dirs hang off this. Omit to skip them
   * (e.g. when the OS home can't be resolved). */
  osHome?: string
  /** Extra skill directories from `config.skillDirs`, scanned as `custom`. */
  customDirs?: string[]
  /** Reuse external agent dirs (Claude Code / Codex / OpenCode) + `customDirs`.
   * Defaults to `true`; pass `false` to scan only the CLI's own `.cognia` dirs. */
  external?: boolean
}

/**
 * Resolve the ordered list of skill directories to scan. Order = precedence
 * (first wins on an id collision):
 *   1. project `.cognia/skills`
 *   2. project `.claude/skills`
 *   3. project `.opencode/skills`
 *   4. global  `<home>/skills`
 *   5. `<osHome>/.claude/skills` (Claude Code)
 *   6. `<osHome>/.agents/skills` (Codex)
 *   7. `<osHome>/.opencode/skills` (OpenCode)
 *   8. each `customDirs` entry
 * Steps 2–3 + 5–8 are skipped when `external` is `false`; 5–7 are also skipped
 * when `osHome` is absent. Non-existent dirs are harmlessly no-ops downstream.
 */
export function skillScanDirs(opts: SkillScanOptions): SkillScanDir[] {
  const { cwd, home, osHome, customDirs, external = true } = opts
  const dirs: SkillScanDir[] = [{ dir: path.join(cwd, ".cognia", "skills"), source: "project" }]
  if (external) {
    dirs.push({ dir: path.join(cwd, ".claude", "skills"), source: "claude-project" })
    dirs.push({ dir: path.join(cwd, ".opencode", "skills"), source: "opencode" })
  }
  dirs.push({ dir: path.join(home, "skills"), source: "global" })
  if (external) {
    if (osHome) {
      dirs.push({ dir: path.join(osHome, ".claude", "skills"), source: "claude" })
      dirs.push({ dir: path.join(osHome, ".agents", "skills"), source: "codex" })
      dirs.push({ dir: path.join(osHome, ".opencode", "skills"), source: "opencode" })
    }
    for (const dir of customDirs ?? []) {
      if (dir.trim()) dirs.push({ dir, source: "custom" })
    }
  }
  return dirs
}

/** Human-readable origin label for a disk skill's canonical id
 * (`cli-disk:<source>:<id>`), for the `/skill` list. Returns `undefined` for a
 * non-disk skill (e.g. a built-in seeded with a different canonical id). */
export function skillOriginLabel(canonicalId: string | undefined): string | undefined {
  if (!canonicalId?.startsWith("cli-disk:")) return undefined
  const source = canonicalId.slice("cli-disk:".length).split(":")[0]
  switch (source) {
    case "project":
      return "project"
    case "global":
      return "global"
    case "claude-project":
      return "claude·proj"
    case "claude":
      return "claude"
    case "codex":
      return "codex"
    case "opencode":
      return "opencode"
    case "custom":
      return "custom"
    default:
      return source || undefined
  }
}

/**
 * Find a disk skill by its canonical id (`cli-disk:<source>:<id>`), re-running
 * discovery against the project + global skill dirs. Returns the discovered
 * record (with `dir` / `filePath`) or `undefined` when the id isn't an on-disk
 * skill (e.g. a built-in seeded into Dexie with a different canonical id).
 */
export async function findDiskSkillByCanonicalId(
  opts: SkillScanOptions,
  canonicalId: string,
  fs: SkillFs = defaultFs
): Promise<DiscoveredSkill | undefined> {
  const all = await discoverDiskSkills(skillScanDirs(opts), fs)
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
  opts: SkillScanOptions,
  upsert: (input: {
    draft: DiscoveredSkill["draft"]
    canonicalId: string
  }) => Promise<{ created: boolean }>,
  fs: SkillFs = defaultFs
): Promise<SeedDiskSkillsResult> {
  const discovered = await discoverDiskSkills(skillScanDirs(opts), fs)
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
