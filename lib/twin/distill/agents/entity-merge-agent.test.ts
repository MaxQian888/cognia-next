import { runEntityMergeAgent, __TESTING__ } from "./entity-merge-agent"
import type { LlmClient } from "../llm"
import type { EntityRole, ProfileEntity } from "@/types/twin"

function mockLlm(responses: string[]): LlmClient {
  let cursor = 0
  return {
    async complete() {
      return responses[Math.min(cursor++, responses.length - 1)]
    },
  }
}

function person(name: string, aliases: string[] = []): ProfileEntity {
  return {
    name,
    aliases,
    role: "person",
    relation: "colleague",
    firstSeenChunkId: `chk_${name}`,
  }
}

function team(name: string, aliases: string[] = []): ProfileEntity {
  return {
    name,
    aliases,
    role: "team",
    firstSeenChunkId: `chk_${name}`,
  }
}

describe("runEntityMergeAgent", () => {
  it("skips buckets below the min-bucket size", async () => {
    const entities = [person("Alice"), person("Bob"), person("Carol")]
    const calls: string[] = []
    const llm: LlmClient = {
      async complete(prompt) {
        calls.push(prompt)
        return "{}"
      },
    }
    const result = await runEntityMergeAgent(llm, { entities, minBucket: 6 })
    expect(calls).toHaveLength(0)
    expect(result.merged).toHaveLength(3)
  })

  it("merges aliases into a canonical entity within one role bucket", async () => {
    const entities: ProfileEntity[] = [
      team("Engineering Infra Team"),
      team("infra-team"),
      team("Eng-Infra"),
      team("Platform Eng"),
      team("Frontend"),
      team("Mobile"),
    ]
    const llm = mockLlm([
      JSON.stringify({
        clusters: [
          {
            canonical: "Engineering Infra Team",
            aliases: ["infra-team", "Eng-Infra"],
          },
        ],
      }),
    ])
    const result = await runEntityMergeAgent(llm, { entities, minBucket: 4 })
    expect(result.collapsed.team).toBe(2)
    const infra = result.merged.find((e) => e.name === "Engineering Infra Team")
    expect(infra).toBeDefined()
    expect(infra!.aliases.sort()).toEqual(["Eng-Infra", "infra-team"].sort())
    expect(result.merged.map((e) => e.name)).not.toContain("infra-team")
    expect(result.merged.map((e) => e.name)).toContain("Frontend")
  })

  it("falls back to the un-merged bucket when the LLM throws", async () => {
    const entities = Array.from({ length: 6 }, (_, i) => team(`t${i}`))
    const llm: LlmClient = {
      async complete() {
        throw new Error("rate limited")
      },
    }
    const result = await runEntityMergeAgent(llm, { entities, minBucket: 4 })
    expect(result.merged).toHaveLength(6)
    expect(result.collapsed).toEqual({})
  })

  it("ignores invalid roles by passing them through untouched", async () => {
    const entities: ProfileEntity[] = [
      // intentionally invalid role
      {
        name: "Spurious",
        aliases: [],
        role: "wrong" as EntityRole,
        firstSeenChunkId: "x",
      },
      ...Array.from({ length: 6 }, (_, i) => team(`t${i}`)),
    ]
    const llm = mockLlm(["{}"])
    const result = await runEntityMergeAgent(llm, { entities, minBucket: 4 })
    expect(result.merged.find((e) => e.name === "Spurious")).toBeDefined()
  })

  it("never clusters or renames a pinned entity (T2.5)", async () => {
    const pinnedTeam: ProfileEntity = { ...team("Eng-Infra"), pinned: true }
    const entities: ProfileEntity[] = [
      team("Engineering Infra Team"),
      team("infra-team"),
      pinnedTeam,
      team("Platform Eng"),
      team("Frontend"),
      team("Mobile"),
    ]
    // The LLM tries to fold the pinned "Eng-Infra" into the canonical.
    const llm = mockLlm([
      JSON.stringify({
        clusters: [{ canonical: "Engineering Infra Team", aliases: ["infra-team", "Eng-Infra"] }],
      }),
    ])
    const result = await runEntityMergeAgent(llm, { entities, minBucket: 4 })
    // Clustering still ran (the non-pinned "infra-team" was folded)...
    expect(result.merged.map((e) => e.name)).not.toContain("infra-team")
    // ...but the pinned entity survives verbatim, never renamed/folded.
    const survivor = result.merged.find((e) => e.name === "Eng-Infra")
    expect(survivor).toBeDefined()
    expect(survivor?.pinned).toBe(true)
  })

  it("buildClusters honours the canonical-key + alias-key map", () => {
    const clusters = __TESTING__.buildClusters("team", [
      { canonical: "Infra", aliases: ["infra-team", "Eng-Infra"] },
    ])
    expect(clusters.canonicalOf.get("infra")).toBe("Infra")
    expect(clusters.canonicalOf.get("infra-team")).toBe("Infra")
    expect(clusters.canonicalOf.get("eng-infra")).toBe("Infra")
    expect(clusters.aliasOf.get("Infra")?.has("infra-team")).toBe(true)
  })
})
