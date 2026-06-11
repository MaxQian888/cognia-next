/**
 * `/skill` controller — list, show, and enable/disable skills for the session.
 * Reuses `lib/db/skills` against the CLI-local Dexie (seeded with the built-in
 * skills). Enabled ids persist to `skill-state.json` and are threaded into the
 * `ephemeralSkillIds` build-options seam by `session-runner`.
 */
import { getSkill, listSkills, upsertSkillByCanonicalId } from "@/lib/db/skills"
import type { Skill } from "@/lib/claude/types"

import { ensureCliDb } from "../../db/bootstrap"
import { readEnabled, setEnabled } from "../../skill/skill-state"
import {
  findDiskSkillByCanonicalId,
  listSkillBundledFiles,
  seedDiskSkills,
  type SkillBundledFile,
} from "../../skill/discover-skills"
import { openDocument } from "./shared"
import type { TuiAction } from "../state/types"

export interface SkillDeps {
  dispatch: (action: TuiAction) => void
  home: string
  /** Project working directory — its `.cognia/skills/` is scanned for SKILL.md
   * skills alongside the global `<home>/skills/`. */
  cwd?: string
  ensureDb?: () => Promise<unknown>
  list?: () => Promise<Skill[]>
  get?: (id: string) => Promise<Skill | undefined>
  getEnabled?: () => Set<string>
  setSkillEnabled?: (id: string, enabled: boolean) => void
  /** Import on-disk SKILL.md skills into Dexie before reads. Injected in tests. */
  seedDisk?: () => Promise<unknown>
  /** Resolve a disk skill's directory by canonical id (`/skill files`). Injected
   * in tests; defaults to {@link findDiskSkillByCanonicalId}. */
  findDisk?: (canonicalId: string) => Promise<{ dir?: string } | undefined>
  /** List a skill directory's bundled files. Injected in tests; defaults to
   * {@link listSkillBundledFiles}. */
  listFiles?: (dir: string) => Promise<SkillBundledFile[]>
}

const dbOf = (d: SkillDeps) => d.ensureDb ?? (() => ensureCliDb())
const enabledOf = (d: SkillDeps) => (d.getEnabled ?? (() => readEnabled(d.home)))()

/** Ensure the db is open, then import any disk SKILL.md skills (idempotent) so
 * `/skill list|show|toggle` all see project + global skills, not just built-ins. */
async function ensureSkillsReady(deps: SkillDeps): Promise<void> {
  await dbOf(deps)()
  const seed =
    deps.seedDisk ??
    (deps.cwd
      ? () => seedDiskSkills(deps.cwd!, deps.home, upsertSkillByCanonicalId)
      : () => Promise.resolve())
  await seed()
}

export async function skillList(deps: SkillDeps): Promise<void> {
  await ensureSkillsReady(deps)
  const skills = await (deps.list ?? listSkills)()
  if (skills.length === 0) {
    deps.dispatch({
      type: "NOTICE",
      message:
        "No skills found. Add a SKILL.md skill under .cognia/skills/<name>/ (project) or ~/.cognia/skills/<name>/ (global).",
    })
    return
  }
  const enabled = enabledOf(deps)
  deps.dispatch({
    type: "OVERLAY_OPEN",
    overlay: {
      kind: "select",
      title: "Skills (Enter toggles for this session)",
      items: skills.map((s) => ({
        id: s.id,
        label: s.name,
        hint: enabled.has(s.id) ? "on" : "off",
      })),
      index: 0,
      onSelectCommand: "skill toggle",
    },
  })
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
    deps.findDisk ?? ((cid: string) => findDiskSkillByCanonicalId(deps.cwd ?? ".", deps.home, cid))
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
