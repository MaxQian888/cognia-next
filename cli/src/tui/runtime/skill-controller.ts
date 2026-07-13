/**
 * `/skill` controller — list, show, and enable/disable skills for the session.
 * Reuses `lib/db/skills` against the CLI-local Dexie (seeded with the built-in
 * skills). Enabled ids persist to `skill-state.json` and are threaded into the
 * `ephemeralSkillIds` build-options seam by `session-runner`.
 */
import os from "node:os"

import {
  createSkill,
  deleteSkill,
  getSkill,
  listSkills,
  upsertSkillByCanonicalId,
} from "@/lib/db/skills"
import type { Skill } from "@cognia/agent-config-types"

import { buildSkillRows } from "./skill-panel-model"

import { ensureCliDb } from "../../db/bootstrap"
import { readEnabled, setEnabled, setManyEnabled } from "../../skill/skill-state"
import {
  findDiskSkillByCanonicalId,
  listSkillBundledFiles,
  seedDiskSkills,
  skillOriginLabel,
  type SkillBundledFile,
  type SkillScanOptions,
} from "../../skill/discover-skills"
import { openDocument } from "./shared"
import type { TuiAction } from "../state/types"

export interface SkillDeps {
  dispatch: (action: TuiAction) => void
  home: string
  /** Project working directory — its `.cognia/skills/` (and, when external
   * reuse is on, `.claude/skills/`) is scanned alongside the global dirs. */
  cwd?: string
  /** OS home (`~`). Claude Code (`~/.claude/skills`), Codex (`~/.agents/skills`)
   * and OpenCode (`~/.opencode/skills`) dirs hang off this. Defaults to
   * {@link os.homedir}; injected in tests. */
  osHome?: string
  /** Reuse external agent dirs (Claude Code / Codex / OpenCode) + {@link skillDirs}.
   * Defaults to on; `false` scans only the CLI's own `.cognia` dirs. */
  externalSkills?: boolean
  /** Extra skill dirs from `config.skillDirs`, scanned as `custom`. */
  skillDirs?: string[]
  ensureDb?: () => Promise<unknown>
  list?: () => Promise<Skill[]>
  get?: (id: string) => Promise<Skill | undefined>
  getEnabled?: () => Set<string>
  setSkillEnabled?: (id: string, enabled: boolean) => void
  /** Bulk enable/disable a batch of ids in one persist (`/skill enable-all` /
   * `disable-all`). Injected in tests; defaults to {@link setManyEnabled}. */
  setManySkillsEnabled?: (ids: string[], enabled: boolean) => void
  /** Import on-disk SKILL.md skills into Dexie before reads. Injected in tests. */
  seedDisk?: () => Promise<unknown>
  /** Resolve a disk skill's directory by canonical id (`/skill files`). Injected
   * in tests; defaults to {@link findDiskSkillByCanonicalId}. */
  findDisk?: (canonicalId: string) => Promise<{ dir?: string } | undefined>
  /** List a skill directory's bundled files. Injected in tests; defaults to
   * {@link listSkillBundledFiles}. */
  listFiles?: (dir: string) => Promise<SkillBundledFile[]>
  /** Persist a new skill (`/skill create`). Injected in tests; defaults to
   * {@link createSkill}. */
  create?: (draft: { name: string; description?: string; content: string }) => Promise<Skill>
  /** Delete a skill (`/skill delete`). Injected in tests; defaults to
   * {@link deleteSkill}. */
  remove?: (id: string) => Promise<void>
}

const dbOf = (d: SkillDeps) => d.ensureDb ?? (() => ensureCliDb())
const enabledOf = (d: SkillDeps) => (d.getEnabled ?? (() => readEnabled(d.home)))()

/** Build the directory-scan options from the deps — the CLI's own `.cognia`
 * dirs plus, when external reuse is on, Claude Code / Codex / configured dirs. */
function scanOptionsOf(deps: SkillDeps): SkillScanOptions {
  return {
    cwd: deps.cwd ?? ".",
    home: deps.home,
    osHome: deps.osHome ?? os.homedir(),
    customDirs: deps.skillDirs,
    external: deps.externalSkills !== false,
  }
}

/** Ensure the db is open, then import any disk SKILL.md skills (idempotent) so
 * `/skill list|show|toggle` all see the CLI's own skills AND the reused Claude
 * Code / Codex / OpenCode / configured skills, not just built-ins. */
async function ensureSkillsReady(deps: SkillDeps): Promise<void> {
  await dbOf(deps)()
  const seed =
    deps.seedDisk ?? (() => seedDiskSkills(scanOptionsOf(deps), upsertSkillByCanonicalId))
  await seed()
}

export async function skillList(deps: SkillDeps): Promise<void> {
  await ensureSkillsReady(deps)
  const skills = await (deps.list ?? listSkills)()
  if (skills.length === 0) {
    deps.dispatch({
      type: "NOTICE",
      message:
        "No skills found. Add a SKILL.md skill under .cognia/skills/<name>/ (project) or ~/.cognia/skills/<name>/ (global). Claude Code (~/.claude/skills), Codex (~/.agents/skills), and OpenCode (~/.opencode/skills) skills are reused automatically.",
    })
    return
  }
  const enabled = enabledOf(deps)
  deps.dispatch({
    type: "OVERLAY_OPEN",
    overlay: {
      kind: "select",
      title: "Skills (Enter toggles for this session)",
      items: skills.map((s) => {
        // Tag reused external skills with their origin (claude / codex / …) so
        // the list makes clear where each skill comes from, not just its name.
        const origin = skillOriginLabel(s.canonicalId)
        const state = enabled.has(s.id) ? "on" : "off"
        return {
          id: s.id,
          label: s.name,
          hint: origin ? `${origin} · ${state}` : state,
        }
      }),
      index: 0,
      onSelectCommand: "skill toggle",
    },
  })
}

/**
 * `/skill` (bare) — open the interactive skills panel: one row per skill with
 * the rich metadata the flat list hid (origin · category · usage · validation
 * warnings) and an enabled badge. Space toggles, Enter opens the detail pager.
 */
export async function skillPanel(deps: SkillDeps): Promise<void> {
  await ensureSkillsReady(deps)
  const skills = await (deps.list ?? listSkills)()
  if (skills.length === 0) {
    deps.dispatch({
      type: "NOTICE",
      message:
        "No skills found. Add one with /skill create, drop a SKILL.md under .cognia/skills/<name>/, or reuse Claude Code (~/.claude/skills), Codex (~/.agents/skills), and OpenCode (~/.opencode/skills) skills automatically.",
    })
    return
  }
  deps.dispatch({
    type: "OVERLAY_OPEN",
    overlay: { kind: "skills", rows: buildSkillRows(skills, enabledOf(deps)) },
  })
}

/**
 * `/skill create --name <n> [--description <d>]` — scaffold a new custom skill
 * in the CLI-local store (persists across sessions). Opens it disabled; the
 * user enables it from the panel. The empty body is a starting point the user
 * fills in by editing the skill on disk or via the desktop app.
 */
export async function skillCreate(args: string, deps: SkillDeps): Promise<void> {
  const flags = parseSkillFlags(args)
  const name = flags.name?.trim()
  if (!name) {
    deps.dispatch({
      type: "NOTICE",
      message: "Usage: /skill create --name <name> [--description <text>]",
    })
    return
  }
  await dbOf(deps)()
  const make =
    deps.create ??
    ((draft: { name: string; description?: string; content: string }) => createSkill(draft))
  const skill = await make({
    name,
    description: flags.description?.trim() || undefined,
    content: `# ${name}\n\n${flags.description?.trim() ?? "Describe what this skill does and when to use it."}\n`,
  })
  deps.dispatch({
    type: "NOTICE",
    message: `Created skill "${skill.name}" (${skill.id}). Enable it with /skill enable ${skill.id}.`,
  })
  await skillPanel(deps)
}

/**
 * `/skill delete <id>` — remove a custom skill. Disk-backed skills (the CLI's
 * own `.cognia/skills`, reused Claude Code / Codex / OpenCode dirs) and built-ins
 * are refused: deleting the row would only have it re-seed from disk on the next
 * list, and removing another tool's files is out of scope.
 */
export async function skillDelete(id: string, deps: SkillDeps): Promise<void> {
  await dbOf(deps)()
  const skill = await (deps.get ?? getSkill)(id)
  if (!skill) {
    deps.dispatch({ type: "NOTICE", message: `Skill ${id} not found.` })
    return
  }
  if (skill.isBuiltIn) {
    deps.dispatch({ type: "NOTICE", message: `"${skill.name}" is built-in and can't be deleted.` })
    return
  }
  if (isDiskSkill(skill)) {
    deps.dispatch({
      type: "NOTICE",
      message: `"${skill.name}" is an on-disk skill — delete its SKILL.md folder to remove it (it would otherwise re-seed).`,
    })
    return
  }
  await (deps.remove ?? deleteSkill)(id)
  // Clear any session-enabled flag so a re-created id doesn't inherit it.
  ;(deps.setSkillEnabled ?? ((i, on) => setEnabled(deps.home, i, on)))(id, false)
  deps.dispatch({ type: "NOTICE", message: `Deleted skill "${skill.name}".` })
  await skillPanel(deps)
}

/** Parse `--flag value …` pairs for `/skill create` (values may span tokens). */
export function parseSkillFlags(args: string): Record<string, string> {
  const tokens = args.trim().split(/\s+/).filter(Boolean)
  const out: Record<string, string> = {}
  let key: string | null = null
  let val: string[] = []
  const flush = () => {
    if (key) out[key] = val.join(" ")
    key = null
    val = []
  }
  for (const t of tokens) {
    if (t.startsWith("--")) {
      flush()
      key = t.slice(2)
    } else if (key) {
      val.push(t)
    }
  }
  flush()
  return out
}

/** Whether a skill was imported from disk (so it may bundle files to browse). */
function isDiskSkill(skill: Skill): boolean {
  return typeof skill.canonicalId === "string" && skill.canonicalId.startsWith("cli-disk:")
}

/**
 * Render a skill's full detail as a markdown document — metadata header
 * (id, source, enabled state, allowed tools, description) followed by the full
 * SKILL.md body. Pure, so the layout is unit-tested without dispatch.
 */
export function buildSkillDocument(skill: Skill, enabled: boolean): string {
  const lines: string[] = [`# ${skill.name}`, ""]
  const meta: string[] = [`\`${skill.id}\``]
  if (skill.source) meta.push(`source: ${skill.source}`)
  meta.push(enabled ? "enabled" : "disabled")
  lines.push(meta.join(" · "), "")
  if (skill.description) lines.push(`> ${skill.description}`, "")
  if (skill.allowedTools && skill.allowedTools.length > 0) {
    lines.push(`**Allowed tools:** ${skill.allowedTools.join(", ")}`, "")
  }
  if (isDiskSkill(skill)) {
    lines.push(`_Run \`/skill files ${skill.id}\` to browse bundled files._`, "")
  }
  lines.push("---", "", skill.content.trim() || "_(empty body)_")
  return lines.join("\n")
}

export async function skillShow(id: string, deps: SkillDeps): Promise<void> {
  await ensureSkillsReady(deps)
  const skill = await (deps.get ?? getSkill)(id)
  if (!skill) {
    deps.dispatch({ type: "NOTICE", message: `Skill ${id} not found.` })
    return
  }
  const enabled = enabledOf(deps).has(skill.id)
  openDocument(deps.dispatch, {
    title: `Skill · ${skill.name}`,
    body: buildSkillDocument(skill, enabled),
    format: "markdown",
  })
}

/**
 * `/skill files <id>` — browse the files bundled inside a folder skill's
 * directory. Selecting one chains into `/view <abspath>`. Only on-disk folder
 * skills bundle files; everything else reports that there are none.
 */
export async function skillFiles(id: string, deps: SkillDeps): Promise<void> {
  await ensureSkillsReady(deps)
  const skill = await (deps.get ?? getSkill)(id)
  if (!skill) {
    deps.dispatch({ type: "NOTICE", message: `Skill ${id} not found.` })
    return
  }
  if (!isDiskSkill(skill) || !skill.canonicalId) {
    deps.dispatch({
      type: "NOTICE",
      message: `Skill "${skill.name}" has no bundled files (not an on-disk folder skill).`,
    })
    return
  }
  const find =
    deps.findDisk ?? ((cid: string) => findDiskSkillByCanonicalId(scanOptionsOf(deps), cid))
  const discovered = await find(skill.canonicalId)
  if (!discovered?.dir) {
    deps.dispatch({
      type: "NOTICE",
      message: `Skill "${skill.name}" bundles no files.`,
    })
    return
  }
  const files = await (deps.listFiles ?? listSkillBundledFiles)(discovered.dir)
  if (files.length === 0) {
    deps.dispatch({ type: "NOTICE", message: `Skill "${skill.name}" bundles no files.` })
    return
  }
  deps.dispatch({
    type: "OVERLAY_OPEN",
    overlay: {
      kind: "select",
      title: `${skill.name} — files (Enter opens)`,
      items: files.map((f) => ({ id: f.absPath, label: f.relPath })),
      index: 0,
      onSelectCommand: "view",
    },
  })
}

export async function skillToggle(id: string, deps: SkillDeps): Promise<void> {
  await dbOf(deps)()
  const enabled = enabledOf(deps)
  const turnOn = !enabled.has(id)
  ;(deps.setSkillEnabled ?? ((i, on) => setEnabled(deps.home, i, on)))(id, turnOn)
  deps.dispatch({
    type: "NOTICE",
    message: `Skill "${id}" ${turnOn ? "enabled" : "disabled"} for this session.`,
  })
}

export function skillSetEnabled(id: string, enabled: boolean, deps: SkillDeps): void {
  ;(deps.setSkillEnabled ?? ((i, on) => setEnabled(deps.home, i, on)))(id, enabled)
  deps.dispatch({
    type: "NOTICE",
    message: `Skill "${id}" ${enabled ? "enabled" : "disabled"} for this session.`,
  })
}

/**
 * `/skill enable-all` / `/skill disable-all` — flip EVERY discovered skill's
 * session-enabled flag in a single persist (全开全关), then re-open the panel so
 * the change is visible at once. The App invalidates the cached SendOptions for
 * the `skill` feature, so the next turn reflects the new set.
 */
export async function skillBulkSetEnabled(enabled: boolean, deps: SkillDeps): Promise<void> {
  await ensureSkillsReady(deps)
  const skills = await (deps.list ?? listSkills)()
  const ids = skills.map((s) => s.id)
  if (ids.length === 0) {
    deps.dispatch({ type: "NOTICE", message: "No skills to update." })
    return
  }
  ;(deps.setManySkillsEnabled ?? ((i, on) => setManyEnabled(deps.home, i, on)))(ids, enabled)
  deps.dispatch({
    type: "NOTICE",
    message: `${enabled ? "Enabled" : "Disabled"} ${ids.length} skill${
      ids.length === 1 ? "" : "s"
    } for this session.`,
  })
  await skillPanel(deps)
}

/** `/skill enable-all` — enable every discovered skill for the session. */
export function skillEnableAll(deps: SkillDeps): Promise<void> {
  return skillBulkSetEnabled(true, deps)
}

/** `/skill disable-all` — disable every discovered skill for the session. */
export function skillDisableAll(deps: SkillDeps): Promise<void> {
  return skillBulkSetEnabled(false, deps)
}
