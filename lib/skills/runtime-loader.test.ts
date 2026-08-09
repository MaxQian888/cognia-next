import type { Skill, SkillResource } from "@cognia/agent-config-types"
import {
  createSkillLoadContext,
  loadSkillForSession,
  loadSkillResourceForSession,
  releaseSkillLoadContext,
} from "./runtime-loader"

const skill: Skill = {
  id: "skill_allowed",
  slug: "allowed",
  name: "Allowed",
  description: "Allowed skill",
  content: "Follow the allowed instructions.",
  createdAt: 1,
  updatedAt: 1,
}
const resources: SkillResource[] = [
  {
    id: "inline",
    skillId: skill.id,
    kind: "reference",
    name: "inline.txt",
    path: "references/inline.txt",
    content: "inline body",
    encoding: "utf-8",
    inline: true,
    createdAt: 1,
    updatedAt: 1,
  },
  {
    id: "large",
    skillId: skill.id,
    kind: "reference",
    name: "large.txt",
    path: "references/large.txt",
    content: "abcdef",
    encoding: "utf-8",
    createdAt: 1,
    updatedAt: 1,
  },
  {
    id: "binary",
    skillId: skill.id,
    kind: "asset",
    name: "image.png",
    path: "assets/image.png",
    content: "iVBORw==",
    encoding: "base64",
    mimeType: "image/png",
    size: 4,
    createdAt: 1,
    updatedAt: 1,
  },
]

describe("session-scoped skill runtime loader", () => {
  const getSkill = jest.fn(async (id: string) => (id === skill.id ? skill : undefined))
  const listResources = jest.fn(async () => resources)
  const recordUsage = jest.fn(async () => undefined)

  beforeEach(() => {
    jest.clearAllMocks()
    releaseSkillLoadContext("session")
    createSkillLoadContext({
      sessionId: "session",
      allowedSkillIds: [skill.id],
      getSkill,
      listResources,
      recordUsage,
    })
  })

  it("loads only catalog-scoped skills, includes a manifest and inline text, and counts once", async () => {
    const loaded = await loadSkillForSession("session", skill.id)
    expect(loaded).toMatchObject({
      ok: true,
      skill: { id: skill.id },
      content: expect.stringContaining("inline body"),
      resources: expect.any(Array),
    })
    await loadSkillForSession("session", skill.id)
    expect(recordUsage).toHaveBeenCalledTimes(1)
    await expect(loadSkillForSession("session", "skill_guessed")).resolves.toMatchObject({
      ok: false,
      code: "out_of_scope",
    })
  })

  it("keeps a successful load usable when best-effort usage persistence fails", async () => {
    const failingUsage = jest.fn(async () => {
      throw new Error("database unavailable")
    })
    createSkillLoadContext({
      sessionId: "session",
      allowedSkillIds: [skill.id],
      getSkill,
      listResources,
      recordUsage: failingUsage,
    })

    await expect(loadSkillForSession("session", skill.id)).resolves.toMatchObject({ ok: true })
    await expect(loadSkillForSession("session", skill.id)).resolves.toMatchObject({ ok: true })
    expect(failingUsage).toHaveBeenCalledTimes(1)
  })

  it("pages UTF-8 resources and never returns base64 bytes to the model", async () => {
    await expect(
      loadSkillResourceForSession("session", skill.id, "references/large.txt", 2, 3)
    ).resolves.toMatchObject({ content: "cde", nextOffset: 5 })
    await expect(
      loadSkillResourceForSession("session", skill.id, "assets/image.png")
    ).resolves.toMatchObject({ binary: true, mimeType: "image/png", size: 4 })
  })

  it("keeps UTF-8 code points intact across byte-page boundaries", async () => {
    createSkillLoadContext({
      sessionId: "session",
      allowedSkillIds: [skill.id],
      getSkill,
      listResources: async () => [
        {
          ...resources[1],
          path: "references/unicode.txt",
          content: "你a",
          size: 4,
        },
      ],
      recordUsage,
    })
    const first = await loadSkillResourceForSession(
      "session",
      skill.id,
      "references/unicode.txt",
      0,
      2
    )
    expect(first).toMatchObject({ content: "你", nextOffset: 3 })
    await expect(
      loadSkillResourceForSession("session", skill.id, "references\\unicode.txt", 3, 1)
    ).resolves.toMatchObject({ content: "a", nextOffset: undefined })
  })

  it("rejects traversal and released contexts", async () => {
    await expect(
      loadSkillResourceForSession("session", skill.id, "../secret.txt")
    ).resolves.toMatchObject({ ok: false, code: "invalid_path" })
    releaseSkillLoadContext("session")
    await expect(loadSkillForSession("session", skill.id)).resolves.toMatchObject({
      ok: false,
      code: "missing_context",
    })
  })
})
