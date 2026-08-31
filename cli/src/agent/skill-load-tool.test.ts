/**
 * @jest-environment node
 */
import {
  LOAD_SKILL_TOOL_NAME,
  LOAD_SKILL_RESOURCE_TOOL_NAME,
  buildLoadSkillManifestEntry,
  buildLoadSkillManifestEntries,
  buildLoadSkillSchema,
  handleCliLoadSkill,
  handleCliLoadSkillResource,
  parseLoadSkillArgs,
  registerCliSkillLoadContext,
  releaseCliSkillLoadContext,
  renderLoadedSkill,
} from "./skill-load-tool"
import type { Skill, SkillResource } from "@cognia/agent-config-types"
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

const resources: SkillResource[] = [
  {
    id: "r1",
    skillId: "deep-research",
    kind: "reference",
    name: "rubric.md",
    path: "references/rubric.md",
    content: "Verify primary sources.",
    encoding: "utf-8",
    createdAt: 0,
    updatedAt: 0,
  },
]

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

  it("advertises both scoped read-only loaders", () => {
    expect(
      buildLoadSkillManifestEntries([{ id: "deep-research", name: "Deep Research" }]).map(
        (entry) => entry.name
      )
    ).toEqual([LOAD_SKILL_TOOL_NAME, LOAD_SKILL_RESOURCE_TOOL_NAME])
  })

  it("keeps the resource id schema open when catalog metadata lookup degrades", () => {
    const resource = buildLoadSkillManifestEntries([])[1].jsonSchema as {
      properties: { skill_id: { enum?: string[] } }
    }
    expect(resource.properties.skill_id.enum).toBeUndefined()
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
  beforeEach(() => {
    releaseCliSkillLoadContext("sess-1")
    registerCliSkillLoadContext("sess-1", {
      allowedSkillIds: ["deep-research"],
      get: async (id) => (id === "deep-research" ? skill() : undefined),
      listResources: async () => resources,
    })
  })

  afterEach(() => releaseCliSkillLoadContext("sess-1"))

  it("returns the skill body as the tool result", async () => {
    const res = await handleCliLoadSkill(req({ skill_id: "deep-research" }))
    expect(res).toMatchObject({ sessionId: "sess-1", toolUseId: "tu-1" })
    expect(res.result).toMatchObject({
      ok: true,
      content: expect.stringContaining("# Deep Research"),
      resources: [expect.objectContaining({ path: "references/rubric.md" })],
    })
    expect(res.error).toBeUndefined()
  })

  it("reports a missing id without throwing", async () => {
    const res = await handleCliLoadSkill(req({ skill_id: "nope" }))
    expect(res.result).toMatchObject({ ok: false, code: "out_of_scope" })
  })

  it("guides the model when no id is supplied", async () => {
    const res = await handleCliLoadSkill(req({}))
    expect(res.result).toContain("provide `{skill_id}`")
  })

  it("collapses a Dexie read failure onto an error string", async () => {
    registerCliSkillLoadContext("sess-1", {
      allowedSkillIds: ["x"],
      get: async () => {
        throw new Error("db locked")
      },
    })
    const res = await handleCliLoadSkill(req({ skill_id: "x" }))
    expect(res.error).toContain("load_skill failed: db locked")
  })

  it("rejects a disabled row even when its id was mistakenly registered", async () => {
    registerCliSkillLoadContext("sess-1", {
      allowedSkillIds: ["deep-research"],
      get: async () => skill({ status: "disabled" }),
    })
    const res = await handleCliLoadSkill(req({ skill_id: "deep-research" }))
    expect(res.result).toMatchObject({ ok: false, code: "out_of_scope" })
  })

  it("pages a resource through the shared scoped loader", async () => {
    const resourceReq = {
      ...req({ skill_id: "deep-research", path: "references/rubric.md", limit: 6 }),
      name: LOAD_SKILL_RESOURCE_TOOL_NAME,
    }
    const res = await handleCliLoadSkillResource(resourceReq)
    expect(res.result).toMatchObject({
      ok: true,
      content: "Verify",
      nextOffset: 6,
    })
  })
})
