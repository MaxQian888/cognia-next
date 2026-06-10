/**
 * `/skill` controller — list, show, and enable/disable skills for the session.
 * Reuses `lib/db/skills` against the CLI-local Dexie (seeded with the built-in
 * skills). Enabled ids persist to `skill-state.json` and are threaded into the
 * `ephemeralSkillIds` build-options seam by `session-runner`.
 */
import { getSkill, listSkills } from "@/lib/db/skills"
import type { Skill } from "@/lib/claude/types"

import { ensureCliDb } from "../../db/bootstrap"
import { readEnabled, setEnabled } from "../../skill/skill-state"
import { truncate } from "./shared"
import type { TuiAction } from "../state/types"

export interface SkillDeps {
  dispatch: (action: TuiAction) => void
  home: string
  ensureDb?: () => Promise<unknown>
  list?: () => Promise<Skill[]>
  get?: (id: string) => Promise<Skill | undefined>
  getEnabled?: () => Set<string>
  setSkillEnabled?: (id: string, enabled: boolean) => void
}

const dbOf = (d: SkillDeps) => d.ensureDb ?? (() => ensureCliDb())
const enabledOf = (d: SkillDeps) => (d.getEnabled ?? (() => readEnabled(d.home)))()

export async function skillList(deps: SkillDeps): Promise<void> {
  await dbOf(deps)()
  const skills = await (deps.list ?? listSkills)()
  if (skills.length === 0) {
    deps.dispatch({ type: "NOTICE", message: "No skills found." })
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

export async function skillShow(id: string, deps: SkillDeps): Promise<void> {
  await dbOf(deps)()
  const skill = await (deps.get ?? getSkill)(id)
  if (!skill) {
    deps.dispatch({ type: "NOTICE", message: `Skill ${id} not found.` })
    return
  }
  const desc = skill.description ? `${skill.description}\n\n` : ""
  deps.dispatch({
    type: "NOTICE",
    message: `${skill.name}\n${desc}${truncate(skill.content, 400)}`,
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
