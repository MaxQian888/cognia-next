jest.mock("@/lib/claude/skills-io", () => ({
  parseSkillMarkdown: jest.fn(),
}))
jest.mock("@/lib/db/skills", () => ({
  listSkills: jest.fn(),
  deleteSkill: jest.fn(),
  upsertSkillByCanonicalId: jest.fn(),
}))
jest.mock("./marketplace-registry", () => ({
  fetchRegistrySkillContent: jest.fn(),
}))
jest.mock("./marketplace-skillssh", () => ({
  fetchSkillsShDetail: jest.fn(),
  fetchSkillsShSkillContent: jest.fn(),
}))

import {
  fetchMarketplaceContent,
  installMarketplaceItem,
  uninstallMarketplaceItem,
  listInstalledCanonicalIds,
} from "./marketplace-install"
import { parseSkillMarkdown } from "@/lib/claude/skills-io"
import { listSkills, deleteSkill, upsertSkillByCanonicalId } from "@/lib/db/skills"
import { fetchRegistrySkillContent } from "./marketplace-registry"
import { fetchSkillsShDetail, fetchSkillsShSkillContent } from "./marketplace-skillssh"
import type { MarketplaceItem } from "./marketplace-types"

const mockedParse = parseSkillMarkdown as unknown as jest.Mock
const mockedList = listSkills as unknown as jest.Mock
const mockedDelete = deleteSkill as unknown as jest.Mock
const mockedUpsert = upsertSkillByCanonicalId as unknown as jest.Mock
const mockedRegFetch = fetchRegistrySkillContent as unknown as jest.Mock
const mockedShDetail = fetchSkillsShDetail as unknown as jest.Mock
const mockedShContent = fetchSkillsShSkillContent as unknown as jest.Mock

beforeEach(() => {
  // resetAllMocks (not clearAllMocks) so leftover `mockResolvedValueOnce`
  // queues from one test don't bleed into the next.
  jest.resetAllMocks()
})

const item = (overrides: Partial<MarketplaceItem> = {}): MarketplaceItem => ({
  id: "x",
  source: "registry",
  sourceId: "id-1",
  name: "Skill",
  description: "desc",
  author: "auth",
  category: "development",
  tags: ["t"],
  license: "MIT",
  ...overrides,
})

describe("fetchMarketplaceContent", () => {
  it("dispatches to the registry adapter", async () => {
    mockedRegFetch.mockResolvedValue({
      content: "X",
      canonicalId: "registry:id-1",
      marketplaceSkillId: "id-1",
    })
    const out = await fetchMarketplaceContent(item({ source: "registry" }))
    expect(out.content).toBe("X")
    expect(mockedRegFetch).toHaveBeenCalled()
  })

  it("dispatches to the skills.sh adapter", async () => {
    mockedShContent.mockResolvedValue({
      content: "Y",
      canonicalId: "skillssh:o/r/s",
      marketplaceSkillId: "o/r/s",
    })
    const out = await fetchMarketplaceContent(item({ source: "skillssh", sourceId: "o/r/s" }))
    expect(out.content).toBe("Y")
    expect(mockedShContent).toHaveBeenCalled()
  })

  it("rejects unknown sources", async () => {
    await expect(
      fetchMarketplaceContent(item({ source: "weird" as unknown as MarketplaceItem["source"] }))
    ).rejects.toThrow(/Unknown marketplace source/)
  })
})

describe("installMarketplaceItem", () => {
  it("delegates to upsertSkillByCanonicalId with the fetched canonicalId and marketplace source", async () => {
    mockedRegFetch.mockResolvedValue({
      content: "MD",
      canonicalId: "registry:id-1",
      marketplaceSkillId: "id-1",
    })
    mockedParse.mockReturnValue({
      draft: {
        name: "ParsedName",
        description: "ParsedDesc",
        content: "BODY",
        allowedTools: ["bash"],
        tags: ["x"],
        category: "development",
        version: "1.0.0",
        author: "A",
        license: "MIT",
      },
    })
    mockedUpsert.mockResolvedValue({
      skill: { id: "new-1", name: "ParsedName" },
      created: true,
    })
    const out = await installMarketplaceItem(item())
    expect(out.created).toBe(true)
    expect(out.skill.id).toBe("new-1")
    expect(mockedUpsert).toHaveBeenCalledWith({
      canonicalId: "registry:id-1",
      draft: expect.objectContaining({
        source: "marketplace",
        marketplaceSkillId: "id-1",
        name: "ParsedName",
      }),
    })
  })

  it("falls back to item-level fields when draft fields are missing", async () => {
    mockedRegFetch.mockResolvedValue({
      content: "MD",
      canonicalId: "registry:id-2",
      marketplaceSkillId: "id-2",
    })
    mockedParse.mockReturnValue({
      draft: { name: "BareName", content: "BODY" },
    })
    mockedUpsert.mockResolvedValue({ skill: { id: "x" }, created: true })
    await installMarketplaceItem(
      item({
        sourceId: "id-2",
        description: "ItemDesc",
        tags: ["it"],
        category: "communication",
        author: "ItemAuthor",
        license: "Apache-2.0",
      })
    )
    expect(mockedUpsert).toHaveBeenCalledWith({
      canonicalId: "registry:id-2",
      draft: expect.objectContaining({
        description: "ItemDesc",
        tags: ["it"],
        category: "communication",
        author: "ItemAuthor",
        license: "Apache-2.0",
      }),
    })
  })

  it("propagates `created: false` from the helper when the upsert touched an existing row", async () => {
    mockedRegFetch.mockResolvedValue({
      content: "MD",
      canonicalId: "registry:id-1",
      marketplaceSkillId: "id-1",
    })
    mockedParse.mockReturnValue({ draft: { name: "P", content: "B" } })
    const existing = { id: "abc", canonicalId: "registry:id-1" }
    mockedUpsert.mockResolvedValue({ skill: existing, created: false })
    const out = await installMarketplaceItem(item())
    expect(out.created).toBe(false)
    expect(out.skill).toEqual(existing)
  })

  it("persists portability findings without disabling an otherwise runnable skill", async () => {
    mockedRegFetch.mockResolvedValue({
      content: "MD",
      canonicalId: "registry:id-1",
      marketplaceSkillId: "id-1",
    })
    // 80-char name violates the validator's length rule but isn't fatal.
    const longName = "a".repeat(80)
    mockedParse.mockReturnValue({ draft: { name: longName, content: "B" } })
    mockedUpsert.mockResolvedValue({ skill: { id: "x" }, created: true })
    const out = await installMarketplaceItem(item())
    expect(out.validationErrors.length).toBeGreaterThan(0)
    expect(mockedUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        draft: expect.objectContaining({
          status: "enabled",
          validationErrors: expect.any(Array),
        }),
      })
    )
  })

  it("installs a clean row as 'disabled' when disabledByDefault is set", async () => {
    mockedRegFetch.mockResolvedValue({
      content: "MD",
      canonicalId: "registry:id-1",
      marketplaceSkillId: "id-1",
    })
    mockedParse.mockReturnValue({ draft: { name: "P", content: "B" } })
    mockedUpsert.mockResolvedValue({ skill: { id: "x" }, created: true })
    await installMarketplaceItem(item(), { disabledByDefault: true })
    expect(mockedUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ draft: expect.objectContaining({ status: "disabled" }) })
    )
  })

  it("keeps a portability-only row disabled when disabledByDefault is set", async () => {
    mockedRegFetch.mockResolvedValue({
      content: "MD",
      canonicalId: "registry:id-1",
      marketplaceSkillId: "id-1",
    })
    mockedParse.mockReturnValue({ draft: { name: "a".repeat(80), content: "B" } })
    mockedUpsert.mockResolvedValue({ skill: { id: "x" }, created: true })
    await installMarketplaceItem(item(), { disabledByDefault: true })
    expect(mockedUpsert).toHaveBeenCalledWith(
      expect.objectContaining({ draft: expect.objectContaining({ status: "disabled" }) })
    )
  })
})

describe("installMarketplaceItem — skills.sh multi-file branch", () => {
  const shItem = (): MarketplaceItem =>
    item({
      id: "skillssh:o/r/s",
      source: "skillssh",
      sourceId: "o/r/s",
      name: "find-skills",
    })

  it("installs the full snapshot as skill + resources with a content hash", async () => {
    mockedShDetail.mockResolvedValue({
      files: [
        { path: "SKILL.md", contents: "---\nname: f\n---\nbody" },
        { path: "scripts/run.sh", contents: "#!/bin/sh" },
        { path: "references/notes.md", contents: "# notes" },
      ],
    })
    // parseBundleManifest consumes the (mocked) parseSkillMarkdown.
    mockedParse.mockReturnValue({
      draft: { name: "find-skills", content: "body" },
      warnings: [],
      portabilityIssues: [],
    })
    mockedUpsert.mockResolvedValue({ skill: { id: "sh-1" }, created: true })

    const out = await installMarketplaceItem(shItem())
    expect(out.created).toBe(true)
    expect(mockedShDetail).toHaveBeenCalled()
    const call = mockedUpsert.mock.calls[0][0]
    expect(call.canonicalId).toBe("skillssh:o/r/s")
    expect(call.draft.source).toBe("marketplace")
    expect(call.draft.marketplaceSkillId).toBe("o/r/s")
    expect(call.draft.marketplaceHash).toMatch(/^sha256:[0-9a-f]+$/)
    expect(call.draft.resources).toHaveLength(2)
    expect(call.draft.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "scripts/run.sh", kind: "script" }),
        expect.objectContaining({ path: "references/notes.md", kind: "reference" }),
      ])
    )
  })

  it("refuses a snapshot without SKILL.md", async () => {
    mockedShDetail.mockResolvedValue({
      files: [{ path: "readme.md", contents: "x" }],
    })
    await expect(installMarketplaceItem(shItem())).rejects.toThrow(/no SKILL\.md/)
    expect(mockedUpsert).not.toHaveBeenCalled()
  })

  it("threads item-level fallbacks for fields the manifest omits", async () => {
    mockedShDetail.mockResolvedValue({
      files: [{ path: "SKILL.md", contents: "---\nname: f\n---\nbody" }],
    })
    mockedParse.mockReturnValue({
      draft: { name: "find-skills", content: "body" },
      warnings: [],
      portabilityIssues: [],
    })
    mockedUpsert.mockResolvedValue({ skill: { id: "sh-2" }, created: true })
    await installMarketplaceItem(shItem())
    const call = mockedUpsert.mock.calls[0][0]
    expect(call.draft.description).toBe("desc")
    expect(call.draft.author).toBe("auth")
    expect(call.draft.license).toBe("MIT")
    expect(call.draft.resources).toBeUndefined()
  })
})

describe("uninstallMarketplaceItem", () => {
  it("returns false when no matching skill exists", async () => {
    mockedList.mockResolvedValue([])
    const out = await uninstallMarketplaceItem(item())
    expect(out).toBe(false)
    expect(mockedDelete).not.toHaveBeenCalled()
  })

  it("deletes the matched row and returns true", async () => {
    mockedList.mockResolvedValue([
      { id: "x", canonicalId: "registry:id-1" },
      { id: "y", canonicalId: "registry:id-2" },
    ])
    mockedDelete.mockResolvedValue(undefined)
    const out = await uninstallMarketplaceItem(item())
    expect(out).toBe(true)
    expect(mockedDelete).toHaveBeenCalledWith("x")
  })
})

describe("listInstalledCanonicalIds", () => {
  it("returns the set of canonicalIds, ignoring rows without one", async () => {
    mockedList.mockResolvedValue([
      { id: "a", canonicalId: "x:1" },
      { id: "b" },
      { id: "c", canonicalId: "y:2" },
    ])
    const out = await listInstalledCanonicalIds()
    expect(out).toEqual(new Set(["x:1", "y:2"]))
  })
})
