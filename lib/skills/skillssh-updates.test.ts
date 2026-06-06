jest.mock("./marketplace-skillssh", () => {
  const actual = jest.requireActual("./marketplace-skillssh")
  return {
    ...actual,
    fetchSkillsShDetail: jest.fn(),
  }
})

import type { Skill } from "@/lib/claude/types"
import { fetchSkillsShDetail } from "./marketplace-skillssh"
import { computeSkillsShFilesHash } from "./skillssh-install"
import {
  checkSkillsShUpdates,
  isSkillsShInstall,
  marketplaceItemFromSkill,
} from "./skillssh-updates"

const mockedDetail = fetchSkillsShDetail as unknown as jest.Mock

function skill(over: Partial<Skill>): Skill {
  return {
    id: "s1",
    name: "find-skills",
    content: "body",
    createdAt: 0,
    updatedAt: 0,
    ...over,
  } as Skill
}

afterEach(() => jest.clearAllMocks())

describe("isSkillsShInstall", () => {
  it("accepts skillssh:owner/repo/slug canonical ids only", () => {
    expect(isSkillsShInstall(skill({ canonicalId: "skillssh:o/r/s" }))).toBe(true)
    expect(isSkillsShInstall(skill({ canonicalId: "registry:x" }))).toBe(false)
    expect(isSkillsShInstall(skill({ canonicalId: "skillssh:not-a-triple" }))).toBe(false)
    expect(isSkillsShInstall(skill({}))).toBe(false)
  })
})

describe("marketplaceItemFromSkill", () => {
  it("rebuilds the MarketplaceItem from the canonical id", () => {
    const item = marketplaceItemFromSkill(skill({ canonicalId: "skillssh:o/r/s" }))
    expect(item).toMatchObject({
      id: "skillssh:o/r/s",
      source: "skillssh",
      sourceId: "o/r/s",
      repository: "o/r",
    })
  })

  it("returns null for non-skillssh rows", () => {
    expect(marketplaceItemFromSkill(skill({ canonicalId: "registry:x" }))).toBeNull()
    expect(marketplaceItemFromSkill(skill({}))).toBeNull()
  })
})

describe("checkSkillsShUpdates", () => {
  const FILES = [{ path: "SKILL.md", contents: "v1" }]

  it("reports no update when the remote hash matches the stored one", async () => {
    const hash = await computeSkillsShFilesHash(FILES)
    mockedDetail.mockResolvedValue({ files: FILES })
    const out = await checkSkillsShUpdates([
      skill({ canonicalId: "skillssh:o/r/s", marketplaceHash: hash }),
    ])
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ hasUpdate: false, currentHash: hash, remoteHash: hash })
  })

  it("reports an update when the remote content changed", async () => {
    const stale = await computeSkillsShFilesHash(FILES)
    mockedDetail.mockResolvedValue({ files: [{ path: "SKILL.md", contents: "v2" }] })
    const out = await checkSkillsShUpdates([
      skill({ canonicalId: "skillssh:o/r/s", marketplaceHash: stale }),
    ])
    expect(out[0].hasUpdate).toBe(true)
    expect(out[0].remoteHash).not.toBe(stale)
  })

  it("skips rows that are not skills.sh installs", async () => {
    const out = await checkSkillsShUpdates([
      skill({ canonicalId: "registry:x" }),
      skill({}),
      skill({ canonicalId: "skillssh:bad" }),
    ])
    expect(out).toEqual([])
    expect(mockedDetail).not.toHaveBeenCalled()
  })

  it("never flags an update for rows without a stored hash, but returns the remote hash", async () => {
    mockedDetail.mockResolvedValue({ files: FILES })
    const out = await checkSkillsShUpdates([skill({ canonicalId: "skillssh:o/r/s" })])
    expect(out[0].hasUpdate).toBe(false)
    expect(out[0].remoteHash).toMatch(/^sha256:/)
  })

  it("captures per-skill failures without aborting the run", async () => {
    mockedDetail
      .mockRejectedValueOnce(new Error("network down"))
      .mockResolvedValueOnce({ files: FILES })
    const hash = await computeSkillsShFilesHash(FILES)
    const out = await checkSkillsShUpdates([
      skill({ id: "s1", canonicalId: "skillssh:o/r/a", marketplaceHash: hash }),
      skill({ id: "s2", canonicalId: "skillssh:o/r/b", marketplaceHash: hash }),
    ])
    expect(out).toHaveLength(2)
    expect(out[0].error).toContain("network down")
    expect(out[1].hasUpdate).toBe(false)
    expect(out[1].error).toBeUndefined()
  })
})
