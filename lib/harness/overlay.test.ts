import type { Character } from "@cognia/agent-config-types"
import {
  harnessOverlaySkillId,
  isHarnessOverlaySkillId,
  materializeHarnessRun,
  overlayResourcesById,
  overlaySkillFromHarness,
} from "./overlay"
import { makeComponents, makeSkill } from "./test-fixtures"

const base = {
  id: "agent-1",
  name: "Analyst",
  systemPrompt: "Old prompt",
  model: "claude-x",
  allowedTools: ["Read"],
  skillIds: ["lib-skill-1"],
  variant: { baseId: "root", ownFields: [] },
  harness: { guardrails: "old" },
} as unknown as Character

describe("overlay skills", () => {
  it("builds collision-free synthetic ids", () => {
    const id = harnessOverlaySkillId("snap-1", "csv-report")
    expect(id).toBe("harness:snap-1:csv-report")
    expect(isHarnessOverlaySkillId(id)).toBe(true)
    expect(isHarnessOverlaySkillId("lib-skill-1")).toBe(false)
  })

  it("projects a harness skill to an enabled in-memory row with its resources", () => {
    const binary = makeSkill({
      resources: [
        ...makeSkill().resources,
        { path: "assets/a.png", kind: "asset", content: "AAAA", encoding: "base64" },
      ],
    })
    const { skill, resources } = overlaySkillFromHarness("snap-1", binary, 5)
    expect(skill).toMatchObject({
      id: "harness:snap-1:csv-report",
      slug: "csv-report",
      status: "enabled",
      tags: ["harness-evolution"],
      createdAt: 5,
    })
    expect(resources.map((r) => [r.path, r.skillId, r.size])).toEqual([
      [
        "scripts/summarize.py",
        "harness:snap-1:csv-report",
        new TextEncoder().encode(binary.resources[0].content).byteLength,
      ],
      ["assets/a.png", "harness:snap-1:csv-report", 3],
    ])
  })
})

describe("materializeHarnessRun", () => {
  it("runs the candidate as the agent without its library skills or variant link", () => {
    const components = makeComponents({ systemPrompt: "New prompt", memory: "Fact." })
    const { character, overlay } = materializeHarnessRun({ id: "snap-2", components }, base, 9)
    expect(character.systemPrompt).toBe("New prompt")
    expect(character.harness).toMatchObject({ guardrails: components.guardrails, memory: "Fact." })
    expect(character.skillIds).toEqual([])
    expect(character).not.toHaveProperty("variant")
    expect(character.model).toBe("claude-x")
    expect(character.allowedTools).toEqual(["Read"])
    expect(base.skillIds).toEqual(["lib-skill-1"])
    expect(overlay.snapshotId).toBe("snap-2")
    expect(overlay.skills.map((s) => s.skill.id)).toEqual(["harness:snap-2:csv-report"])
    const byId = overlayResourcesById(overlay)
    expect(byId.get("harness:snap-2:csv-report")?.[0].path).toBe("scripts/summarize.py")
    expect(overlayResourcesById(undefined).size).toBe(0)
  })
})
