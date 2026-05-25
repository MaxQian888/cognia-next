import { REVIEW_BOARD_TEMPLATE } from "./template"
import { validateTemplateRequires } from "@/lib/plugin/registries/agent-team-template-registry"
import { registerSkill, __resetSkillsForTesting } from "@/lib/plugin/registries/skill-registry"
import {
  registerSubagent,
  __resetSubagentsForTesting,
} from "@/lib/plugin/registries/subagent-registry"
import {
  registerCharacterPack,
  __resetCharacterPacksForTesting,
} from "@/lib/plugin/registries/character-pack-registry"
import { REFACTOR_ROLE_PACK } from "../characters/pack"
import { REFACTOR_SKILLS } from "../skills/definitions"
import { REFACTOR_SUBAGENTS } from "../subagents/definitions"
import { PLUGIN_ID } from "../ids"

function registerOwnContributions() {
  for (const s of REFACTOR_SKILLS) registerSkill(s.id, s, { pluginId: PLUGIN_ID })
  for (const sub of REFACTOR_SUBAGENTS) registerSubagent(sub.id, sub, { pluginId: PLUGIN_ID })
  registerCharacterPack(REFACTOR_ROLE_PACK.id, REFACTOR_ROLE_PACK, { pluginId: PLUGIN_ID })
}

function resetAll() {
  __resetSkillsForTesting()
  __resetSubagentsForTesting()
  __resetCharacterPacksForTesting()
}

beforeEach(resetAll)
afterEach(resetAll)

describe("REVIEW_BOARD_TEMPLATE", () => {
  it("is a review-category board with a roster of three and seeded tasks", () => {
    expect(REVIEW_BOARD_TEMPLATE.category).toBe("review")
    expect(REVIEW_BOARD_TEMPLATE.teammates).toHaveLength(3)
    expect(REVIEW_BOARD_TEMPLATE.taskTemplates).toHaveLength(3)
    for (const t of REVIEW_BOARD_TEMPLATE.taskTemplates ?? []) {
      expect(typeof t.assignedToIndex).toBe("number")
      expect((t.assignedToIndex ?? -1) < REVIEW_BOARD_TEMPLATE.teammates.length).toBe(true)
    }
  })

  it("reports missing requires before the plugin's contributions register", () => {
    expect(validateTemplateRequires(REVIEW_BOARD_TEMPLATE).ok).toBe(false)
  })

  it("requires fully resolve once the plugin registers its own contributions", () => {
    registerOwnContributions()
    const result = validateTemplateRequires(REVIEW_BOARD_TEMPLATE)
    expect(result.warnings).toEqual([])
    expect(result.ok).toBe(true)
  })
})
