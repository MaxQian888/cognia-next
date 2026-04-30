jest.mock("@/lib/tauri", () => ({
  isTauri: jest.fn(),
}))
jest.mock("@/lib/claude/ipc", () => ({
  skillsFetchRemoteMd: jest.fn(),
}))
jest.mock("@/stores/settings", () => ({
  useSettingsStore: { getState: jest.fn() },
}))

import {
  getSkillsMpBaseUrl,
  isSkillsMpEnabled,
  fetchSkillsMpItems,
  fetchSkillsMpItem,
  fetchSkillsMpSkillContent,
} from "./marketplace-skillsmp"
import { isTauri } from "@/lib/tauri"
import { skillsFetchRemoteMd } from "@/lib/claude/ipc"
import { useSettingsStore } from "@/stores/settings"
import type { MarketplaceItem } from "./marketplace-types"

const mockedIsTauri = isTauri as unknown as jest.Mock
const mockedFetchMd = skillsFetchRemoteMd as unknown as jest.Mock
const mockedSettingsGetState = useSettingsStore.getState as unknown as jest.Mock

const realFetch = global.fetch

beforeEach(() => {
  jest.clearAllMocks()
  global.fetch = realFetch
})

describe("getSkillsMpBaseUrl / isSkillsMpEnabled", () => {
  it("returns null when settings missing", () => {
    mockedSettingsGetState.mockReturnValue({ settings: null })
    expect(getSkillsMpBaseUrl()).toBeNull()
    expect(isSkillsMpEnabled()).toBe(false)
  })

  it("returns null when url is empty/whitespace", () => {
    mockedSettingsGetState.mockReturnValue({ settings: { skillsMpBaseUrl: "" } })
    expect(getSkillsMpBaseUrl()).toBeNull()
    mockedSettingsGetState.mockReturnValue({ settings: { skillsMpBaseUrl: "   " } })
    expect(getSkillsMpBaseUrl()).toBeNull()
  })

  it("strips trailing slashes", () => {
    mockedSettingsGetState.mockReturnValue({ settings: { skillsMpBaseUrl: "https://api/" } })
    expect(getSkillsMpBaseUrl()).toBe("https://api")
    mockedSettingsGetState.mockReturnValue({ settings: { skillsMpBaseUrl: "https://api///" } })
    expect(getSkillsMpBaseUrl()).toBe("https://api")
    expect(isSkillsMpEnabled()).toBe(true)
  })
})

describe("fetchSkillsMpItems", () => {
  it("returns [] when no base url is set", async () => {
    mockedSettingsGetState.mockReturnValue({ settings: null })
    expect(await fetchSkillsMpItems()).toEqual([])
  })

  it("builds query params and converts items[]", async () => {
    mockedSettingsGetState.mockReturnValue({ settings: { skillsMpBaseUrl: "https://api" } })
    global.fetch = jest.fn(async (url: string) => {
      expect(url).toBe(
        "https://api/skills?q=hello&category=development&page=2&pageSize=10&sort=popular"
      )
      return {
        ok: true,
        json: async () => ({
          items: [
            {
              id: 42,
              name: "Forty Two",
              description: "d",
              author: "a",
              category: "development",
              skillmdUrl: "https://md",
              tags: ["t"],
              stars: 1,
              downloads: 2,
              license: "MIT",
            },
          ],
        }),
      }
    }) as unknown as typeof fetch
    const out = await fetchSkillsMpItems({
      search: "hello",
      category: "development",
      page: 2,
      pageSize: 10,
      sort: "popular",
    })
    expect(out.length).toBe(1)
    expect(out[0]).toEqual({
      id: "skillsmp:42",
      source: "skillsmp",
      sourceId: "42",
      name: "Forty Two",
      description: "d",
      author: "a",
      category: "development",
      tags: ["t"],
      repository: undefined,
      iconUrl: undefined,
      rawSkillUrl: "https://md",
      stars: 1,
      downloads: 2,
      license: "MIT",
    })
  })

  it("falls back to data field when items missing, defaults to 'custom' category", async () => {
    mockedSettingsGetState.mockReturnValue({ settings: { skillsMpBaseUrl: "https://api" } })
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ data: [{ id: "x", name: "X" }] }),
    })) as unknown as typeof fetch
    const out = await fetchSkillsMpItems({})
    expect(out[0].category).toBe("custom")
    expect(out[0].sourceId).toBe("x")
  })

  it("returns [] when neither items nor data present", async () => {
    mockedSettingsGetState.mockReturnValue({ settings: { skillsMpBaseUrl: "https://api" } })
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({}),
    })) as unknown as typeof fetch
    const out = await fetchSkillsMpItems()
    expect(out).toEqual([])
  })

  it("throws an informative error when status is not ok with body", async () => {
    mockedSettingsGetState.mockReturnValue({ settings: { skillsMpBaseUrl: "https://api" } })
    global.fetch = jest.fn(async () => ({
      ok: false,
      status: 500,
      statusText: "Internal",
      text: async () => "long body".repeat(100),
    })) as unknown as typeof fetch
    await expect(fetchSkillsMpItems()).rejects.toThrow(/500 Internal/)
  })

  it("throws when status not ok and body read fails", async () => {
    mockedSettingsGetState.mockReturnValue({ settings: { skillsMpBaseUrl: "https://api" } })
    global.fetch = jest.fn(async () => ({
      ok: false,
      status: 404,
      statusText: "Not Found",
      text: async () => {
        throw new Error("read fail")
      },
    })) as unknown as typeof fetch
    await expect(fetchSkillsMpItems()).rejects.toThrow(/404 Not Found/)
  })
})

describe("fetchSkillsMpItem", () => {
  it("returns null when no base url", async () => {
    mockedSettingsGetState.mockReturnValue({ settings: null })
    expect(await fetchSkillsMpItem("x")).toBeNull()
  })

  it("returns the converted item on success", async () => {
    mockedSettingsGetState.mockReturnValue({ settings: { skillsMpBaseUrl: "https://api" } })
    global.fetch = jest.fn(async () => ({
      ok: true,
      json: async () => ({ id: "abc", name: "ABC", category: "communication" }),
    })) as unknown as typeof fetch
    const out = await fetchSkillsMpItem("abc")
    expect(out?.sourceId).toBe("abc")
    expect(out?.category).toBe("communication")
  })

  it("returns null when the underlying request fails", async () => {
    mockedSettingsGetState.mockReturnValue({ settings: { skillsMpBaseUrl: "https://api" } })
    const consoleSpy = jest.spyOn(console, "warn").mockImplementation(() => {})
    global.fetch = jest.fn(async () => ({
      ok: false,
      status: 500,
      statusText: "Err",
      text: async () => "",
    })) as unknown as typeof fetch
    expect(await fetchSkillsMpItem("z")).toBeNull()
    consoleSpy.mockRestore()
  })
})

describe("fetchSkillsMpSkillContent", () => {
  it("rejects without a rawSkillUrl", async () => {
    mockedIsTauri.mockReturnValue(false)
    await expect(
      fetchSkillsMpSkillContent({
        id: "x",
        source: "skillsmp",
        sourceId: "id",
        name: "n",
        category: "custom",
      } as MarketplaceItem)
    ).rejects.toThrow(/no skillmdUrl/)
  })

  it("uses Tauri IPC fetcher when in Tauri", async () => {
    mockedIsTauri.mockReturnValue(true)
    mockedFetchMd.mockResolvedValue("CONTENT")
    const out = await fetchSkillsMpSkillContent({
      id: "skillsmp:x",
      source: "skillsmp",
      sourceId: "x",
      name: "n",
      category: "custom",
      rawSkillUrl: "https://r/SKILL.md",
    } as MarketplaceItem)
    expect(out.content).toBe("CONTENT")
    expect(out.canonicalId).toBe("skillsmp:x")
    expect(out.marketplaceSkillId).toBe("x")
    expect(out.rawUrl).toBe("https://r/SKILL.md")
  })

  it("falls back to fetch in web mode", async () => {
    mockedIsTauri.mockReturnValue(false)
    global.fetch = jest.fn(async () => ({
      ok: true,
      text: async () => "WEB",
    })) as unknown as typeof fetch
    const out = await fetchSkillsMpSkillContent({
      id: "skillsmp:y",
      source: "skillsmp",
      sourceId: "y",
      name: "n",
      category: "custom",
      rawSkillUrl: "https://r/y.md",
    } as MarketplaceItem)
    expect(out.content).toBe("WEB")
  })

  it("throws when fetch is not ok", async () => {
    mockedIsTauri.mockReturnValue(false)
    global.fetch = jest.fn(async () => ({ ok: false, status: 404 })) as unknown as typeof fetch
    await expect(
      fetchSkillsMpSkillContent({
        id: "skillsmp:z",
        source: "skillsmp",
        sourceId: "z",
        name: "n",
        category: "custom",
        rawSkillUrl: "https://r/z.md",
      } as MarketplaceItem)
    ).rejects.toThrow(/404/)
  })
})
