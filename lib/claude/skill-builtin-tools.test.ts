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
import { getCatalogSkill } from "@/lib/skills/built-in-catalog"

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

  it("builds a single Skill manifest entry that lists built-in skills", () => {
    const entries = buildSkillManifestEntries()
    expect(entries).toHaveLength(1)
    const [e] = entries
    expect(e.name).toBe(SKILL_TOOL_NAME)
    expect(e.pluginId).toBe(SKILL_BUILTIN_PLUGIN_ID)
    expect(e.jsonSchema).toMatchObject({ required: ["name"] })
    // Description embeds the catalog so the model can discover skills.
    expect(e.description).toMatch(/Built-in skills:/)
    expect(e.description).toMatch(/- [a-z-]+:/)
    expect(e.description).toContain("- plugin-authoring: plugin-authoring")
  })

  it("loads the canonical plugin authoring workflow through the Skill tool", async () => {
    const out = await runSkillBuiltinTool(
      SKILL_TOOL_NAME,
      { name: "plugin-authoring" },
      { getCatalogSkill }
    )

    expect(out).toContain('Skill "plugin-authoring" loaded')
    expect(out).toContain("cognia plugin contract")
    expect(out).toContain("--point-kind <kind>")
    expect(out).toContain("Stop at a build-ready artifact by default")
  })

  it("identifies the Skill tool name", () => {
    expect(isSkillBuiltinTool(SKILL_TOOL_NAME)).toBe(true)
    expect(isSkillBuiltinTool("web_search")).toBe(false)
  })

  it("returns a catalog skill's instructions as text", async () => {
    const deps: SkillToolRunDeps = {
      getCatalogSkill: (id) =>
        id === "web-research"
          ? { id, name: "Web research", content: "Do the research." }
          : undefined,
    }
    const out = await runSkillBuiltinTool(SKILL_TOOL_NAME, { name: "web-research" }, deps)
    expect(out).toContain("Web research")
    expect(out).toContain("Do the research.")
    expect(out).toMatch(/Follow these instructions/)
  })

  it("falls back to a custom skill and appends caller input", async () => {
    const deps: SkillToolRunDeps = {
      getCatalogSkill: () => undefined,
      loadCustomSkill: async (key) =>
        key === "my-skill" ? { id: "x", name: "My skill", content: "Body." } : undefined,
    }
    const out = (await runSkillBuiltinTool(
      SKILL_TOOL_NAME,
      { name: "my-skill", input: "extra ctx" },
      deps
    )) as string
    expect(out).toContain("My skill")
    expect(out).toContain("Caller-provided input:")
    expect(out).toContain("extra ctx")
  })

  it("returns errors for unknown skill, missing name, and wrong tool", async () => {
    const deps: SkillToolRunDeps = { getCatalogSkill: () => undefined }
    expect(await runSkillBuiltinTool(SKILL_TOOL_NAME, { name: "nope" }, deps)).toMatch(/not found/)
    expect(await runSkillBuiltinTool(SKILL_TOOL_NAME, {}, deps)).toMatch(/requires a `name`/)
    expect(await runSkillBuiltinTool("other", { name: "x" }, deps)).toMatch(/unknown skill tool/)
  })
})
