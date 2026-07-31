import { expertiseMatchScore, rankAssigneesForTask, tokenize } from "./twin-expertise-hints"
import type { AgentTeammate } from "@/types/agent/agent-team"
import type { TeamTwinSummary } from "./team-run-context"

const mate = (id: string, twinId?: string): AgentTeammate =>
  ({
    id,
    teamId: "t1",
    name: `Mate ${id}`,
    description: "",
    role: "teammate",
    status: "idle",
    config: twinId ? { twinId } : {},
    completedTaskIds: [],
    tokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    progress: 0,
    createdAt: new Date(),
  }) as AgentTeammate

const twins: TeamTwinSummary[] = [
  { id: "twin-fe", name: "Ada", expertise: "Senior frontend engineer [React, Design System]" },
  { id: "twin-db", name: "Bo", expertise: "Database performance tuning [Postgres, Indexing]" },
  { id: "twin-empty", name: "Cy", expertise: "" },
]

describe("tokenize", () => {
  it("lowercases, keeps ≥3-char word tokens, and handles CJK", () => {
    expect(tokenize("Fix React SSR bug!")).toEqual(["fix", "react", "ssr", "bug"])
    expect(tokenize("a of x")).toEqual([])
    expect(tokenize("数据库性能")).toEqual(["数据库性能"])
  })
})

describe("expertiseMatchScore", () => {
  it("counts distinct token hits, case-insensitively", () => {
    expect(expertiseMatchScore(["react", "react", "postgres"], twins[0].expertise)).toBe(1)
    expect(expertiseMatchScore(["postgres", "indexing"], twins[1].expertise)).toBe(2)
    expect(expertiseMatchScore([], twins[0].expertise)).toBe(0)
    expect(expertiseMatchScore(["react"], "")).toBe(0)
  })
})

describe("rankAssigneesForTask", () => {
  const roster = [mate("plain"), mate("fe", "twin-fe"), mate("db", "twin-db")]

  it("puts the strongest expertise match first with twin metadata attached", () => {
    const hints = rankAssigneesForTask(
      { title: "Tune Postgres indexing", tags: ["database"] },
      roster,
      twins
    )
    expect(hints[0]).toMatchObject({
      teammateId: "db",
      twinId: "twin-db",
      twinName: "Bo",
      score: 3, // postgres + indexing + database
    })
    // Twin-bound but unmatched ranks above plain teammates.
    expect(hints.map((h) => h.teammateId)).toEqual(["db", "fe", "plain"])
  })

  it("is stable by roster order when nothing matches", () => {
    const hints = rankAssigneesForTask({ title: "misc chore", tags: [] }, roster, twins)
    expect(hints.map((h) => h.teammateId)).toEqual(["fe", "db", "plain"])
    expect(hints.every((h) => h.score === 0)).toBe(true)
  })

  it("tolerates unknown twin ids and empty rosters", () => {
    const hints = rankAssigneesForTask(
      { title: "x", tags: [] },
      [mate("ghost-bound", "twin-unknown")],
      twins
    )
    expect(hints[0]).toMatchObject({ teammateId: "ghost-bound", twinId: "twin-unknown", score: 0 })
    expect(hints[0].twinName).toBeUndefined()
    expect(rankAssigneesForTask({ title: "x", tags: [] }, [], twins)).toEqual([])
  })
})
