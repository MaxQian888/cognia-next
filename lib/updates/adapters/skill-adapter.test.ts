/** @jest-environment jsdom */
import { createSkillAdapter, skillVersionLabel, type SkillUpdateRow } from "./skill-adapter"
import type { CatalogEntry } from "../catalog-types"

function row(overrides: Partial<SkillUpdateRow> = {}): SkillUpdateRow {
  return {
    skillId: "s1",
    canonicalId: "skillssh:acme/repo/skill",
    name: "Acme skill",
    hasUpdate: true,
    currentHash: "aaaaaaaaaaaa1111",
    remoteHash: "bbbbbbbbbbbb2222",
    ...overrides,
  }
}

const CONTEXT = {
  channel: "stable" as const,
  rolloutBucket: 0,
  manual: true,
  catalog: null as readonly CatalogEntry[] | null,
}

describe("skillVersionLabel", () => {
  it("shortens a hash to something readable and stable", () => {
    expect(skillVersionLabel("abcdef0123456789")).toBe("abcdef012345")
  })

  it("does not invent a version for a skill with no hash", () => {
    expect(skillVersionLabel(undefined)).toBe("unknown")
  })
})

describe("check", () => {
  it("offers a skill whose content drifted", async () => {
    const adapter = createSkillAdapter({ checkAll: async () => [row()] })
    const [candidate] = await adapter.check(CONTEXT)
    expect(candidate).toMatchObject({
      assetId: "s1",
      currentVersion: "aaaaaaaaaaaa",
      targetVersion: "bbbbbbbbbbbb",
      executor: "skill-runtime",
    })
  })

  it("ignores a skill whose check failed rather than guessing", async () => {
    const adapter = createSkillAdapter({
      checkAll: async () => [row({ error: "404" })],
    })
    expect(await adapter.check(CONTEXT)).toEqual([])
  })

  it("ignores an unchanged skill", async () => {
    const adapter = createSkillAdapter({ checkAll: async () => [row({ hasUpdate: false })] })
    expect(await adapter.check(CONTEXT)).toEqual([])
  })

  it("always demands review, because skill content is what the agent runs", async () => {
    const adapter = createSkillAdapter({ checkAll: async () => [row()] })
    const [candidate] = await adapter.check(CONTEXT)
    expect(candidate.permissionsExpanded).toBe(true)
  })

  it("never offers a revoked snapshot", async () => {
    const adapter = createSkillAdapter({ checkAll: async () => [row()] })
    const found = await adapter.check({
      ...CONTEXT,
      catalog: [
        {
          assetId: "skillssh:acme/repo/skill",
          kind: "skill",
          executor: "skill-runtime",
          version: "bbbbbbbbbbbb",
          channel: "stable",
          criticality: "routine",
          releasedAt: "2026-01-01T00:00:00Z",
          revoked: true,
        },
      ],
    })
    expect(found).toEqual([])
  })
})

describe("apply", () => {
  it("refuses to replace skill content without consent", async () => {
    let installed = false
    const adapter = createSkillAdapter({
      checkAll: async () => [row()],
      updateOne: async () => {
        installed = true
      },
    })
    const [candidate] = await adapter.check(CONTEXT)
    const result = await adapter.apply(candidate, { consented: false })
    expect(result.state).toBe("awaiting-consent")
    expect(installed).toBe(false)
  })

  it("reinstalls from the source once consented", async () => {
    const installed: string[] = []
    const adapter = createSkillAdapter({
      checkAll: async () => [row()],
      updateOne: async (id) => {
        installed.push(id)
      },
    })
    const [candidate] = await adapter.check(CONTEXT)
    expect((await adapter.apply(candidate, { consented: true })).state).toBe("verified")
    expect(installed).toEqual(["s1"])
  })

  it("reports the missing installer rather than silently doing nothing", async () => {
    const adapter = createSkillAdapter({ checkAll: async () => [row()] })
    const [candidate] = await adapter.check(CONTEXT)
    const result = await adapter.apply(candidate, { consented: true })
    expect(result.state).toBe("failed")
    expect(result.failure?.code).toBe("no_skill_installer")
  })
})
