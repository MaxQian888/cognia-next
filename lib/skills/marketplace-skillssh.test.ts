jest.mock("./skillssh-http", () => {
  class SkillsHttpError extends Error {
    status: number
    retryAfter?: string
    constructor(status: number, message: string, retryAfter?: string) {
      super(message)
      this.name = "SkillsHttpError"
      this.status = status
      this.retryAfter = retryAfter
    }
  }
  return {
    SkillsHttpError,
    skillsHttpGetJson: jest.fn(),
  }
})
jest.mock("@/stores/settings", () => ({
  useSettingsStore: {
    getState: jest.fn(() => ({ settings: {} })),
  },
}))

import { useSettingsStore } from "@/stores/settings"
import { SkillsHttpError, skillsHttpGetJson } from "./skillssh-http"
import {
  SkillsShTokenError,
  fetchSkillsShAudit,
  fetchSkillsShCurated,
  fetchSkillsShDetail,
  fetchSkillsShItems,
  fetchSkillsShLeaderboard,
  fetchSkillsShSkillContent,
  getSkillsShToken,
  parseSkillsShTriple,
} from "./marketplace-skillssh"
import type { MarketplaceItem } from "./marketplace-types"

const mockedGetJson = skillsHttpGetJson as unknown as jest.Mock
const mockedGetState = useSettingsStore.getState as unknown as jest.Mock

function setToken(token?: string) {
  mockedGetState.mockReturnValue({ settings: { skillsShToken: token } })
}

const ITEM: MarketplaceItem = {
  id: "skillssh:vercel-labs/skills/find-skills",
  source: "skillssh",
  sourceId: "vercel-labs/skills/find-skills",
  name: "find-skills",
  repository: "vercel-labs/skills",
}

afterEach(() => {
  jest.clearAllMocks()
  setToken(undefined)
})

describe("token + triple helpers", () => {
  it("getSkillsShToken trims and nullifies empty", () => {
    setToken("  tok  ")
    expect(getSkillsShToken()).toBe("tok")
    setToken("   ")
    expect(getSkillsShToken()).toBeNull()
    setToken(undefined)
    expect(getSkillsShToken()).toBeNull()
  })

  it("parseSkillsShTriple parses owner/repo/slug and rejects other shapes", () => {
    expect(parseSkillsShTriple("a/b/c")).toEqual({ owner: "a", repo: "b", slug: "c" })
    expect(parseSkillsShTriple("a/b")).toBeNull()
    expect(parseSkillsShTriple("a/b/c/d")).toBeNull()
    expect(parseSkillsShTriple("")).toBeNull()
  })
})

describe("fetchSkillsShItems (anonymous search)", () => {
  it("maps search results to MarketplaceItem", async () => {
    mockedGetJson.mockResolvedValueOnce({
      query: "react",
      searchType: "fuzzy",
      skills: [
        {
          id: "expo/skills/react-native",
          skillId: "react-native",
          name: "React Native",
          installs: 3842,
          source: "expo/skills",
        },
      ],
    })
    const items = await fetchSkillsShItems({ search: "react" })
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({
      id: "skillssh:expo/skills/react-native",
      source: "skillssh",
      sourceId: "expo/skills/react-native",
      name: "React Native",
      repository: "expo/skills",
      downloads: 3842,
    })
    expect(mockedGetJson).toHaveBeenCalledWith("https://skills.sh/api/search?q=react&limit=50")
  })

  it("returns [] without a network call for short queries", async () => {
    await expect(fetchSkillsShItems({ search: "r" })).resolves.toEqual([])
    await expect(fetchSkillsShItems({})).resolves.toEqual([])
    expect(mockedGetJson).not.toHaveBeenCalled()
  })
})

describe("fetchSkillsShLeaderboard (token-gated)", () => {
  it("throws SkillsShTokenError without a token", async () => {
    await expect(fetchSkillsShLeaderboard("trending")).rejects.toBeInstanceOf(SkillsShTokenError)
    expect(mockedGetJson).not.toHaveBeenCalled()
  })

  it("fetches a page with the bearer token and maps pagination", async () => {
    setToken("tok")
    mockedGetJson.mockResolvedValueOnce({
      data: [
        {
          id: "vercel-labs/skills/find-skills",
          slug: "find-skills",
          name: "find-skills",
          source: "vercel-labs/skills",
          installs: 24531,
        },
      ],
      pagination: { page: 0, perPage: 50, total: 8000, hasMore: true },
    })
    const page = await fetchSkillsShLeaderboard("trending", 0)
    expect(page.hasMore).toBe(true)
    expect(page.items[0].id).toBe("skillssh:vercel-labs/skills/find-skills")
    expect(mockedGetJson).toHaveBeenCalledWith(
      "https://skills.sh/api/v1/skills?view=trending&page=0&per_page=50",
      { bearerToken: "tok" }
    )
  })

  it("maps a 401 to SkillsShTokenError", async () => {
    setToken("expired")
    mockedGetJson.mockRejectedValueOnce(new SkillsHttpError(401, "unauthorized"))
    await expect(fetchSkillsShLeaderboard("hot")).rejects.toBeInstanceOf(SkillsShTokenError)
  })

  it("propagates 429 with retryAfter untouched", async () => {
    setToken("tok")
    mockedGetJson.mockRejectedValueOnce(new SkillsHttpError(429, "rate limited", "30"))
    const err: unknown = await fetchSkillsShLeaderboard("all-time").catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SkillsHttpError)
    expect((err as SkillsHttpError).retryAfter).toBe("30")
  })
})

describe("fetchSkillsShCurated", () => {
  it("maps owners and their skills", async () => {
    setToken("tok")
    mockedGetJson.mockResolvedValueOnce({
      data: [
        {
          owner: "vercel-labs",
          totalInstalls: 89240,
          skills: [
            {
              id: "vercel-labs/skills/find-skills",
              slug: "find-skills",
              name: "find-skills",
              source: "vercel-labs/skills",
              installs: 24531,
            },
          ],
        },
      ],
    })
    const owners = await fetchSkillsShCurated()
    expect(owners).toHaveLength(1)
    expect(owners[0].owner).toBe("vercel-labs")
    expect(owners[0].totalInstalls).toBe(89240)
    expect(owners[0].items[0].source).toBe("skillssh")
  })
})

describe("fetchSkillsShDetail", () => {
  it("uses the anonymous download endpoint without a token", async () => {
    mockedGetJson.mockResolvedValueOnce({
      files: [{ path: "SKILL.md", contents: "---\nname: x\n---\nbody" }],
    })
    const detail = await fetchSkillsShDetail(ITEM)
    expect(detail.hash).toBeUndefined()
    expect(detail.files).toHaveLength(1)
    expect(mockedGetJson).toHaveBeenCalledWith(
      "https://skills.sh/api/download/vercel-labs/skills/find-skills"
    )
  })

  it("uses /api/v1 with a token and keeps the hash", async () => {
    setToken("tok")
    mockedGetJson.mockResolvedValueOnce({
      id: "vercel-labs/skills/find-skills",
      hash: "abc123",
      files: [{ path: "SKILL.md", contents: "x" }],
    })
    const detail = await fetchSkillsShDetail(ITEM)
    expect(detail.hash).toBe("abc123")
    expect(mockedGetJson).toHaveBeenCalledWith(
      "https://skills.sh/api/v1/skills/vercel-labs/skills/find-skills",
      { bearerToken: "tok" }
    )
  })

  it("falls back to anonymous download when the token is rejected", async () => {
    setToken("expired")
    mockedGetJson
      .mockRejectedValueOnce(new SkillsHttpError(401, "unauthorized"))
      .mockResolvedValueOnce({ files: [{ path: "SKILL.md", contents: "x" }] })
    const detail = await fetchSkillsShDetail(ITEM)
    expect(detail.files).toHaveLength(1)
    expect(detail.hash).toBeUndefined()
  })

  it("throws when the snapshot has no files", async () => {
    mockedGetJson.mockResolvedValueOnce({ files: [] })
    await expect(fetchSkillsShDetail(ITEM)).rejects.toThrow(/no files/)
  })

  it("throws on a malformed sourceId", async () => {
    await expect(fetchSkillsShDetail({ ...ITEM, sourceId: "not-a-triple" })).rejects.toThrow(
      /malformed/
    )
  })
})

describe("fetchSkillsShAudit", () => {
  it("normalises the anonymous audit map", async () => {
    mockedGetJson.mockResolvedValueOnce({
      "find-skills": {
        ath: { risk: "safe", analyzedAt: "2026-03-14" },
        socket: { risk: "safe", alerts: 0, score: 90 },
        snyk: { risk: "medium" },
        zeroleaks: { risk: "safe", score: 93 },
      },
    })
    const audit = await fetchSkillsShAudit(ITEM)
    expect(audit).not.toBeNull()
    expect(audit!.providers).toHaveLength(4)
    expect(audit!.worstRisk).toBe("medium")
    const socket = audit!.providers.find((p) => p.provider === "Socket")
    expect(socket).toMatchObject({ risk: "safe", score: 90 })
    expect(audit!.providers.map((p) => p.provider)).toContain("Agent Trust Hub")
    expect(mockedGetJson).toHaveBeenCalledWith(
      "https://add-skill.vercel.sh/audit?source=vercel-labs%2Fskills&skills=find-skills"
    )
  })

  it("normalises the /api/v1 audits array when a token is present", async () => {
    setToken("tok")
    mockedGetJson.mockResolvedValueOnce({
      audits: [
        { provider: "Socket", status: "pass", summary: "No alerts" },
        { provider: "Snyk", status: "warn", riskLevel: "MEDIUM", summary: "1 issue" },
        { provider: "Gen Agent Trust Hub", status: "fail", riskLevel: "CRITICAL" },
      ],
    })
    const audit = await fetchSkillsShAudit(ITEM)
    expect(audit!.providers).toEqual([
      expect.objectContaining({ provider: "Socket", risk: "safe" }),
      expect.objectContaining({ provider: "Snyk", risk: "medium" }),
      expect.objectContaining({ provider: "Gen Agent Trust Hub", risk: "critical" }),
    ])
    expect(audit!.worstRisk).toBe("critical")
  })

  it("returns null on 404 (not audited yet)", async () => {
    mockedGetJson.mockRejectedValueOnce(new SkillsHttpError(404, "not found"))
    await expect(fetchSkillsShAudit(ITEM)).resolves.toBeNull()
  })

  it("returns null when the slug is absent from the anonymous response", async () => {
    mockedGetJson.mockResolvedValueOnce({})
    await expect(fetchSkillsShAudit(ITEM)).resolves.toBeNull()
  })

  it("falls back to the anonymous endpoint when the token is rejected", async () => {
    setToken("expired")
    mockedGetJson
      .mockRejectedValueOnce(new SkillsHttpError(401, "unauthorized"))
      .mockResolvedValueOnce({ "find-skills": { socket: { risk: "safe" } } })
    const audit = await fetchSkillsShAudit(ITEM)
    expect(audit!.providers).toHaveLength(1)
  })

  it("maps unknown risk strings to unknown", async () => {
    mockedGetJson.mockResolvedValueOnce({
      "find-skills": { socket: { risk: "weird-value" } },
    })
    const audit = await fetchSkillsShAudit(ITEM)
    expect(audit!.providers[0].risk).toBe("unknown")
    expect(audit!.worstRisk).toBe("unknown")
  })
})

describe("fetchSkillsShSkillContent", () => {
  it("extracts SKILL.md and provenance fields", async () => {
    mockedGetJson.mockResolvedValueOnce({
      files: [
        { path: "SKILL.md", contents: "---\nname: f\n---\nbody" },
        { path: "scripts/run.sh", contents: "#!/bin/sh" },
      ],
    })
    const content = await fetchSkillsShSkillContent(ITEM)
    expect(content.content).toContain("name: f")
    expect(content.canonicalId).toBe("skillssh:vercel-labs/skills/find-skills")
    expect(content.marketplaceSkillId).toBe("vercel-labs/skills/find-skills")
  })

  it("throws when SKILL.md is missing", async () => {
    mockedGetJson.mockResolvedValueOnce({
      files: [{ path: "readme.md", contents: "x" }],
    })
    await expect(fetchSkillsShSkillContent(ITEM)).rejects.toThrow(/no SKILL\.md/)
  })
})
