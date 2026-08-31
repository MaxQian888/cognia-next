/** @cognia-host-integration-test */
import { REVIEW_BOARD_TEMPLATE } from "./template"
import { validateTemplateRequires } from "@cognia/plugin-sdk/api/agent-team-template"
import { registerSkill, unregisterSkillsByPlugin } from "@cognia/plugin-sdk/api/skill"
import { registerSubagent, unregisterSubagentsByPlugin } from "@cognia/plugin-sdk/api/subagent"
import { createCharacterPacksAPI } from "@/lib/plugin/api/character-packs-api"
import { REFACTOR_ROLE_PACK } from "../characters/pack"
import { REFACTOR_SKILLS } from "../skills/definitions"
import { REFACTOR_SUBAGENTS } from "../subagents/definitions"
import { PLUGIN_ID } from "../ids"

let unregisterPack: (() => void) | undefined

function registerOwnContributions() {
  for (const s of REFACTOR_SKILLS) registerSkill(s.id, s, { pluginId: PLUGIN_ID })
  for (const sub of REFACTOR_SUBAGENTS) registerSubagent(sub.id, sub, { pluginId: PLUGIN_ID })
  unregisterPack = createCharacterPacksAPI(PLUGIN_ID).register(REFACTOR_ROLE_PACK).unregister
}

/**
 * Plugin-scoped teardown — the three calls the plugin manager makes on
 * disable. A registry-wide reset would also drop contributions this plugin
 * never made, and is not part of the author surface.
 */
function resetAll() {
  unregisterSkillsByPlugin(PLUGIN_ID)
  unregisterSubagentsByPlugin(PLUGIN_ID)
  unregisterPack?.()
  unregisterPack = undefined
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
