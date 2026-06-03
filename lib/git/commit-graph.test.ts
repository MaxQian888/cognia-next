import { assignLanes } from "./commit-graph"
import type { GitCommit, GitRef } from "@/types/git"

function c(hash: string, parents: string[]): GitCommit {
  return {
    hash,
    shortHash: hash.slice(0, 7),
    summary: hash,
    body: "",
    authorName: "T",
    authorEmail: "t@e.com",
    authoredAtMs: 0,
    parents,
  }
}

describe("assignLanes", () => {
  it("keeps a linear chain in a single lane with straight edges", () => {
    const { rows, laneCount } = assignLanes([c("A", ["B"]), c("B", ["C"]), c("C", [])])
    expect(laneCount).toBe(1)
    expect(rows.map((r) => r.lane)).toEqual([0, 0, 0])
    // A→B and B→C are straight; C is a root (no edges).
    expect(rows[0].edges).toEqual([{ fromLane: 0, toLane: 0, color: 0 }])
    expect(rows[1].edges).toEqual([{ fromLane: 0, toLane: 0, color: 0 }])
    expect(rows[2].edges).toEqual([])
  })

  it("opens a lane for a merge and closes it at the shared base", () => {
    // M merges A and B; both descend from base.
    const { rows, laneCount } = assignLanes([
      c("M", ["A", "B"]),
      c("A", ["base"]),
      c("B", ["base"]),
      c("base", []),
    ])
    expect(laneCount).toBe(2)
    const M = rows[0]
    expect(M.lane).toBe(0)
    // M emits a straight edge to A (lane 0) and a diagonal to B (lane 1).
    expect(M.edges).toContainEqual({ fromLane: 0, toLane: 0, color: 0 })
    expect(M.edges).toContainEqual({ fromLane: 0, toLane: 1, color: 1 })
    // B sits in lane 1 and merges back into base's lane 0.
    const B = rows.find((r) => r.commit.hash === "B")!
    expect(B.lane).toBe(1)
    expect(B.edges).toContainEqual({ fromLane: 1, toLane: 0, color: 0 })
    // base is a root.
    expect(rows.find((r) => r.commit.hash === "base")!.edges).toEqual([])
  })

  it("handles two sibling tips converging on one parent (fork)", () => {
    const { rows, laneCount } = assignLanes([c("C1", ["P"]), c("C2", ["P"]), c("P", [])])
    expect(laneCount).toBe(2)
    expect(rows[0].lane).toBe(0)
    expect(rows[1].lane).toBe(1)
    // C2 (lane 1) merges into P's lane 0.
    expect(rows[1].edges).toContainEqual({ fromLane: 1, toLane: 0, color: 0 })
    expect(rows[2].commit.hash).toBe("P")
    expect(rows[2].edges).toEqual([])
  })

  it("opens multiple lanes for an octopus merge", () => {
    const { rows, laneCount } = assignLanes([
      c("O", ["p1", "p2", "p3"]),
      c("p1", []),
      c("p2", []),
      c("p3", []),
    ])
    expect(laneCount).toBe(3)
    // O connects to all three parent lanes.
    expect(rows[0].edges).toHaveLength(3)
    expect(rows[0].edges.map((e) => e.toLane).sort()).toEqual([0, 1, 2])
  })

  it("attaches refs to the matching row", () => {
    const refs: GitRef[] = [
      { name: "main", kind: "branch", targetHash: "A" },
      { name: "v1", kind: "tag", targetHash: "C" },
      { name: "HEAD", kind: "head", targetHash: "A" },
    ]
    const { rows } = assignLanes([c("A", ["B"]), c("B", ["C"]), c("C", [])], refs)
    expect(rows[0].refs.map((r) => r.name).sort()).toEqual(["HEAD", "main"])
    expect(rows[1].refs).toEqual([])
    expect(rows[2].refs.map((r) => r.name)).toEqual(["v1"])
  })

  it("returns an empty layout for no commits", () => {
    expect(assignLanes([])).toEqual({ rows: [], laneCount: 0 })
  })

  it("keeps lane count minimal — a closed branch frees its lane", () => {
    // A feature branch (F) merges into main (M), then main continues linearly.
    const { laneCount } = assignLanes([
      c("M", ["m1", "F"]),
      c("m1", ["base"]),
      c("F", ["base"]),
      c("base", ["older"]),
      c("older", []),
    ])
    // Never needs more than 2 lanes; the closed feature lane is reused/freed.
    expect(laneCount).toBe(2)
  })
})
