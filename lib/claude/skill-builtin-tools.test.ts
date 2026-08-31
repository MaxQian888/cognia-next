const loadSkillForSessionMock = jest.fn()
const loadSkillResourceForSessionMock = jest.fn()
jest.mock("@/lib/skills/runtime-loader", () => ({
  loadSkillForSession: (...args: unknown[]) => loadSkillForSessionMock(...args),
  loadSkillResourceForSession: (...args: unknown[]) => loadSkillResourceForSessionMock(...args),
}))

import {
  SKILL_TOOL_NAME,
  SKILL_BUILTIN_PLUGIN_ID,
  LOAD_SKILL_RESOURCE_TOOL_NAME,
  LOAD_SKILL_TOOL_NAME,
  buildProgressiveSkillManifestEntries,
  buildSkillManifestEntries,
  isSkillBuiltinTool,
  runSkillBuiltinTool,
  type SkillToolRunDeps,
} from "./skill-builtin-tools"

describe("skill-builtin-tools", () => {
  beforeEach(() => {
    loadSkillForSessionMock.mockReset()
    loadSkillResourceForSessionMock.mockReset()
  })

  it("builds scoped progressive loader manifests", () => {
    const entries = buildProgressiveSkillManifestEntries(
      [{ id: "s1", slug: "demo", name: "Demo", description: "Does demos" }],
      true
    )
    expect(entries.map((entry) => entry.name)).toEqual([
      LOAD_SKILL_TOOL_NAME,
      LOAD_SKILL_RESOURCE_TOOL_NAME,
    ])
    expect(entries[0].jsonSchema).toEqual(
      expect.objectContaining({
        properties: expect.objectContaining({
          skill_id: expect.objectContaining({ enum: ["s1"] }),
        }),
      })
    )
  })

  it("routes load_skill through the session scope", async () => {
    loadSkillForSessionMock.mockResolvedValueOnce({ ok: true, content: "body" })
    await expect(
      runSkillBuiltinTool(
        LOAD_SKILL_TOOL_NAME,
        { skill_id: "s1" },
        { listSkillResources: async () => [] },
        { sessionId: "sess" }
      )
    ).resolves.toEqual({ ok: true, content: "body" })
    expect(loadSkillForSessionMock).toHaveBeenCalledWith(
      "sess",
      "s1",
      expect.objectContaining({ listResources: expect.any(Function) })
    )
    loadSkillForSessionMock.mockResolvedValueOnce({ ok: false, code: "out_of_scope" })
    await expect(
      runSkillBuiltinTool(
        LOAD_SKILL_TOOL_NAME,
        { skill_id: "other" },
        { listSkillResources: async () => [] },
        { sessionId: "sess" }
      )
    ).resolves.toEqual({ ok: false, code: "out_of_scope" })
  })

  it("builds a scoped compatibility manifest without advertising the global catalog", () => {
    const entries = buildSkillManifestEntries()
    expect(entries).toHaveLength(1)
    const [e] = entries
    expect(e.name).toBe(SKILL_TOOL_NAME)
    expect(e.pluginId).toBe(SKILL_BUILTIN_PLUGIN_ID)
    expect(e.jsonSchema).toMatchObject({ required: ["name"] })
    expect(e.description).toContain("available in this send")
    expect(e.description).not.toMatch(/Built-in skills:/)
    expect(e.description).not.toContain("plugin-authoring")
  })

  it("routes the legacy Skill alias through the same scoped resource-aware loader", async () => {
    loadSkillForSessionMock.mockResolvedValueOnce({
      ok: true,
      skill: { id: "skill_builtin_plugin_authoring", name: "plugin-authoring" },
      resources: [{ path: "references/contract.md" }],
      content: "# plugin-authoring\n\nCanonical instructions",
    })
    const out = await runSkillBuiltinTool(
      SKILL_TOOL_NAME,
      { name: "builtin:plugin-authoring", input: "build this" },
      {},
      { sessionId: "sess" }
    )

    expect(loadSkillForSessionMock).toHaveBeenCalledWith(
      "sess",
      "builtin:plugin-authoring",
      undefined
    )
    expect(out).toMatchObject({
      ok: true,
      content: expect.stringContaining("Caller-provided input:\nbuild this"),
    })
  })

  it("identifies the Skill tool name", () => {
    expect(isSkillBuiltinTool(SKILL_TOOL_NAME)).toBe(true)
    expect(isSkillBuiltinTool("web_search")).toBe(false)
  })

  it("returns scoped errors for unknown skill, missing name, and wrong tool", async () => {
    const deps: SkillToolRunDeps = {}
    loadSkillForSessionMock.mockResolvedValueOnce({ ok: false, code: "out_of_scope" })
    expect(
      await runSkillBuiltinTool(SKILL_TOOL_NAME, { name: "nope" }, deps, { sessionId: "sess" })
    ).toEqual({ ok: false, code: "out_of_scope" })
    expect(await runSkillBuiltinTool(SKILL_TOOL_NAME, {}, deps)).toMatch(/requires a `name`/)
    expect(await runSkillBuiltinTool("other", { name: "x" }, deps)).toMatch(/unknown skill tool/)
  })
})
