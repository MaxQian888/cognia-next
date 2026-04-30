jest.mock("@/lib/claude/skills-io", () => ({
  parseSkillMarkdown: jest.fn(),
}))
jest.mock("@/lib/db/skills", () => ({
  createSkill: jest.fn(),
  listSkills: jest.fn(),
  updateSkill: jest.fn(),
  deleteSkill: jest.fn(),
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
import { createSkill, listSkills, updateSkill, deleteSkill } from "@/lib/db/skills"
import { fetchRegistrySkillContent } from "./marketplace-registry"
import { fetchSkillsMpSkillContent } from "./marketplace-skillsmp"
import type { MarketplaceItem } from "./marketplace-types"

const mockedParse = parseSkillMarkdown as unknown as jest.Mock
const mockedList = listSkills as unknown as jest.Mock
const mockedCreate = createSkill as unknown as jest.Mock
const mockedUpdate = updateSkill as unknown as jest.Mock
const mockedDelete = deleteSkill as unknown as jest.Mock
const mockedRegFetch = fetchRegistrySkillContent as unknown as jest.Mock
const mockedSmpFetch = fetchSkillsMpSkillContent as unknown as jest.Mock

beforeEach(() => {
  jest.clearAllMocks()
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
  it("creates a fresh row when no existing canonicalId matches", async () => {
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
    mockedList.mockResolvedValue([])
    mockedCreate.mockResolvedValue({ id: "new-1", name: "ParsedName" })
    const out = await installMarketplaceItem(item())
    expect(out.created).toBe(true)
    expect(out.skill.id).toBe("new-1")
    expect(mockedCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        canonicalId: "registry:id-1",
        marketplaceSkillId: "id-1",
        source: "marketplace",
      })
    )
  })

  it("falls back to item-level fields when draft fields are missing on create", async () => {
    mockedRegFetch.mockResolvedValue({
      content: "MD",
      canonicalId: "registry:id-2",
      marketplaceSkillId: "id-2",
    })
    mockedParse.mockReturnValue({
      draft: {
        name: "BareName",
        content: "BODY",
        // description / tags / category / author / license missing → trigger fallback branches
      },
    })
    mockedList.mockResolvedValue([])
    mockedCreate.mockResolvedValue({ id: "fallback", name: "BareName" })
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
    expect(mockedCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        description: "ItemDesc",
        tags: ["it"],
        category: "communication",
        author: "ItemAuthor",
        license: "Apache-2.0",
      })
    )
  })

  it("falls back to item-level fields on update when draft fields are missing", async () => {
    mockedRegFetch.mockResolvedValue({
      content: "MD",
      canonicalId: "registry:id-3",
      marketplaceSkillId: "id-3",
    })
    mockedParse.mockReturnValue({
      draft: {
        name: "P",
        content: "B",
      },
    })
    const existing = { id: "exists", canonicalId: "registry:id-3" }
    mockedList
      .mockResolvedValueOnce([existing])
      .mockResolvedValueOnce([{ id: "exists", name: "P" }])
    await installMarketplaceItem(
      item({
        sourceId: "id-3",
        description: "ItemDesc",
        tags: ["it"],
        category: "communication",
        author: "ItemAuthor",
        license: "Apache-2.0",
      })
    )
    expect(mockedUpdate).toHaveBeenCalledWith(
      "exists",
      expect.objectContaining({
        description: "ItemDesc",
        tags: ["it"],
        category: "communication",
        author: "ItemAuthor",
        license: "Apache-2.0",
      })
    )
  })

  it("updates existing row when canonicalId matches and returns refreshed row", async () => {
    mockedRegFetch.mockResolvedValue({
      content: "MD",
      canonicalId: "registry:id-1",
      marketplaceSkillId: "id-1",
    })
    mockedParse.mockReturnValue({
      draft: { name: "P", content: "B" },
    })
    const existing = { id: "abc", canonicalId: "registry:id-1" }
    const refreshed = { id: "abc", name: "P", canonicalId: "registry:id-1" }
    mockedList.mockResolvedValueOnce([existing]).mockResolvedValueOnce([refreshed])
    const out = await installMarketplaceItem(item())
    expect(mockedUpdate).toHaveBeenCalledWith(
      "abc",
      expect.objectContaining({ canonicalId: "registry:id-1", source: "marketplace" })
    )
    expect(out.created).toBe(false)
    expect(out.skill).toEqual(refreshed)
  })

  it("falls back to existing row when refreshed lookup misses", async () => {
    mockedRegFetch.mockResolvedValue({
      content: "MD",
      canonicalId: "registry:id-1",
      marketplaceSkillId: "id-1",
    })
    mockedParse.mockReturnValue({ draft: { name: "P", content: "B" } })
    const existing = { id: "abc", canonicalId: "registry:id-1" }
    mockedList.mockResolvedValueOnce([existing]).mockResolvedValueOnce([])
    const out = await installMarketplaceItem(item())
    expect(out.skill).toEqual(existing)
    expect(out.created).toBe(false)
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
