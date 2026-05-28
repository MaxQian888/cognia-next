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
jest.mock("./marketplace-skillsmp", () => ({
  fetchSkillsMpSkillContent: jest.fn(),
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
import { fetchSkillsMpSkillContent } from "./marketplace-skillsmp"
import type { MarketplaceItem } from "./marketplace-types"

const mockedParse = parseSkillMarkdown as unknown as jest.Mock
const mockedList = listSkills as unknown as jest.Mock
const mockedDelete = deleteSkill as unknown as jest.Mock
const mockedUpsert = upsertSkillByCanonicalId as unknown as jest.Mock
const mockedRegFetch = fetchRegistrySkillContent as unknown as jest.Mock
const mockedSmpFetch = fetchSkillsMpSkillContent as unknown as jest.Mock

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

  it("dispatches to the skillsmp adapter", async () => {
    mockedSmpFetch.mockResolvedValue({
      content: "Y",
      canonicalId: "skillsmp:id-1",
      marketplaceSkillId: "id-1",
    })
    const out = await fetchMarketplaceContent(item({ source: "skillsmp" }))
    expect(out.content).toBe("Y")
    expect(mockedSmpFetch).toHaveBeenCalled()
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

  it("threads non-fatal validation errors onto the persisted draft and sets status='error'", async () => {
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
          status: "error",
          validationErrors: expect.any(Array),
        }),
      })
    )
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
