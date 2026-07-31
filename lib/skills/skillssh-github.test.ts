jest.mock("./marketplace-skillssh", () => {
  const actual = jest.requireActual("./marketplace-skillssh")
  return {
    ...actual,
    fetchSkillsShDetail: jest.fn(),
  }
})

import { fetchSkillsShDetail } from "./marketplace-skillssh"
import { SkillsHttpError } from "./skillssh-http"
import {
  SkillsShSlugRequiredError,
  parseSkillsShInput,
  resolveSkillsShRef,
} from "./skillssh-github"

const mockedDetail = fetchSkillsShDetail as unknown as jest.Mock

afterEach(() => jest.clearAllMocks())

describe("parseSkillsShInput", () => {
  it("parses a skills.sh page URL", () => {
    expect(parseSkillsShInput("https://skills.sh/vercel-labs/skills/find-skills")).toEqual({
      kind: "full",
      owner: "vercel-labs",
      repo: "skills",
      slug: "find-skills",
    })
  })

  it("parses www / trailing-slash / query variants", () => {
    expect(parseSkillsShInput("https://www.skills.sh/a/b/c/")).toEqual({
      kind: "full",
      owner: "a",
      repo: "b",
      slug: "c",
    })
    expect(parseSkillsShInput("https://skills.sh/a/b/c?tab=files")).toEqual({
      kind: "full",
      owner: "a",
      repo: "b",
      slug: "c",
    })
  })

  it("parses a github.com repo URL as repo-only", () => {
    expect(parseSkillsShInput("https://github.com/vercel-labs/skills")).toEqual({
      kind: "repo-only",
      owner: "vercel-labs",
      repo: "skills",
    })
  })

  it("parses bare triples and owner/repo pairs", () => {
    expect(parseSkillsShInput("a/b/c")).toEqual({ kind: "full", owner: "a", repo: "b", slug: "c" })
    expect(parseSkillsShInput("  a/b  ")).toEqual({ kind: "repo-only", owner: "a", repo: "b" })
  })

  it("rejects invalid shapes", () => {
    expect(parseSkillsShInput("")).toEqual({ kind: "invalid" })
    expect(parseSkillsShInput("just-one")).toEqual({ kind: "invalid" })
    expect(parseSkillsShInput("a/b/c/d")).toEqual({ kind: "invalid" })
    expect(parseSkillsShInput("https://example.com/a/b/c")).toEqual({ kind: "invalid" })
    expect(parseSkillsShInput("a/b c/d")).toEqual({ kind: "invalid" })
    expect(parseSkillsShInput("https://[bad")).toEqual({ kind: "invalid" })
  })
})

describe("resolveSkillsShRef", () => {
  it("resolves a full triple to an item + snapshot", async () => {
    mockedDetail.mockResolvedValue({ files: [{ path: "SKILL.md", contents: "x" }] })
    const out = await resolveSkillsShRef({
      kind: "full",
      owner: "o",
      repo: "r",
      slug: "s",
    })
    expect(out.item).toMatchObject({
      id: "skillssh:o/r/s",
      source: "skillssh",
      sourceId: "o/r/s",
      repository: "o/r",
      name: "s",
    })
    expect(out.detail.files).toHaveLength(1)
  })

  it("defaults the slug to the repo name for repo-only refs", async () => {
    mockedDetail.mockResolvedValue({ files: [{ path: "SKILL.md", contents: "x" }] })
    const out = await resolveSkillsShRef({ kind: "repo-only", owner: "o", repo: "r" })
    expect(out.item.sourceId).toBe("o/r/r")
  })

  it("maps a repo-only 404 to the slug-required guidance error", async () => {
    mockedDetail.mockRejectedValue(new SkillsHttpError(404, "not found"))
    await expect(
      resolveSkillsShRef({ kind: "repo-only", owner: "o", repo: "r" })
    ).rejects.toBeInstanceOf(SkillsShSlugRequiredError)
  })

  it("propagates a 404 on a full triple unchanged (typo, not slug guessing)", async () => {
    mockedDetail.mockRejectedValue(new SkillsHttpError(404, "not found"))
    await expect(
      resolveSkillsShRef({ kind: "full", owner: "o", repo: "r", slug: "nope" })
    ).rejects.toBeInstanceOf(SkillsHttpError)
  })
})
