/**
 * @jest-environment node
 */
import {
  LOAD_SKILL_TOOL_NAME,
  buildLoadSkillManifestEntry,
  buildLoadSkillSchema,
  handleCliLoadSkill,
  parseLoadSkillArgs,
  renderLoadedSkill,
} from "./skill-load-tool"
import type { Skill } from "@cognia/agent-config-types"
import type { PluginToolExecRequest } from "@/lib/claude/plugin-tool-ipc"

function skill(over: Partial<Skill> = {}): Skill {
  return {
    id: "deep-research",
    name: "Deep Research",
    description: "Fan out web searches",
    content: "Step 1. Search broadly.\nStep 2. Verify each claim.",
    createdAt: 0,
    updatedAt: 0,
    ...over,
  } as Skill
}

function req(args: Record<string, unknown>): PluginToolExecRequest {
  return {
    name: LOAD_SKILL_TOOL_NAME,
    args,
    sessionId: "sess-1",
    toolUseId: "tu-1",
  } as PluginToolExecRequest
}

describe("buildLoadSkillSchema / manifest", () => {
  it("constrains skill_id to the known ids when available", () => {
    const schema = buildLoadSkillSchema([
      { id: "a", name: "A" },
      { id: "b", name: "B" },
    ]) as { properties: { skill_id: { enum?: string[] } }; required: string[] }
    expect(schema.properties.skill_id.enum).toEqual(["a", "b"])
    expect(schema.required).toEqual(["skill_id"])
  })

  it("omits the enum when no skills are advertised", () => {
    const schema = buildLoadSkillSchema([]) as {
      properties: { skill_id: { enum?: string[] } }
    }
    expect(schema.properties.skill_id.enum).toBeUndefined()
  })

  it("manifest lists the skills in the description", () => {
    const entry = buildLoadSkillManifestEntry([
      { id: "deep-research", name: "Deep Research", description: "Fan out" },
    ])
    expect(entry.name).toBe(LOAD_SKILL_TOOL_NAME)
    expect(entry.description).toContain("deep-research: Fan out")
  })

  it("manifest description falls back to a generic line with no skills", () => {
    expect(buildLoadSkillManifestEntry([]).description).not.toContain("Available skills:")
  })
})

describe("parseLoadSkillArgs", () => {
  it("reads skill_id and common aliases", () => {
    expect(parseLoadSkillArgs({ skill_id: "x" })).toBe("x")
    expect(parseLoadSkillArgs({ skillId: " y " })).toBe("y")
    expect(parseLoadSkillArgs({ id: "z" })).toBe("z")
    expect(parseLoadSkillArgs({ name: "n" })).toBe("n")
  })

  it("returns null for a missing/blank id", () => {
    expect(parseLoadSkillArgs({})).toBeNull()
    expect(parseLoadSkillArgs({ skill_id: "  " })).toBeNull()
    expect(parseLoadSkillArgs({ skill_id: 7 })).toBeNull()
  })
})

describe("renderLoadedSkill", () => {
  it("renders the name heading + trimmed body", () => {
    expect(renderLoadedSkill(skill())).toBe(
      "# Deep Research\n\nStep 1. Search broadly.\nStep 2. Verify each claim."
    )
  })

  it("notes an empty body", () => {
    expect(renderLoadedSkill(skill({ content: "   " }))).toContain("empty body")
  })
})

describe("handleCliLoadSkill", () => {
  it("returns the skill body as the tool result", async () => {
    const res = await handleCliLoadSkill(req({ skill_id: "deep-research" }), {
      get: async () => skill(),
    })
    expect(res).toMatchObject({ sessionId: "sess-1", toolUseId: "tu-1" })
    expect(res.result).toContain("# Deep Research")
    expect(res.error).toBeUndefined()
  })

  it("reports a missing id without throwing", async () => {
    const res = await handleCliLoadSkill(req({ skill_id: "nope" }), { get: async () => undefined })
    expect(res.result).toContain('no skill found with id "nope"')
  })

  it("guides the model when no id is supplied", async () => {
    const res = await handleCliLoadSkill(req({}), { get: async () => skill() })
    expect(res.result).toContain("provide `{skill_id}`")
  })

  it("collapses a Dexie read failure onto an error string", async () => {
    const res = await handleCliLoadSkill(req({ skill_id: "x" }), {
      get: async () => {
        throw new Error("db locked")
      },
    })
    expect(res.error).toContain("load_skill failed: db locked")
  })
})
