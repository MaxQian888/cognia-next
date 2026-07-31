// DAG-resolution tests for the Claude Code transcript parser (ADR-0062).

import {
  linearizeActiveLeaf,
  splitMainAndSidechain,
  extractSidechains,
  type DagNode,
} from "./claude-code-dag"

interface Rec extends DagNode {
  tag?: string
}
const node = (
  uuid: string,
  parentUuid: string | null,
  timestamp: string,
  extra: Partial<Rec> = {}
): Rec => ({ uuid, parentUuid, timestamp, ...extra })

describe("linearizeActiveLeaf", () => {
  it("returns [] for empty input", () => {
    expect(linearizeActiveLeaf([])).toEqual([])
  })

  it("keeps a linear chain in root→leaf order regardless of file order", () => {
    const shuffled = [
      node("c", "b", "2024-01-01T00:00:03Z"),
      node("a", null, "2024-01-01T00:00:01Z"),
      node("b", "a", "2024-01-01T00:00:02Z"),
    ]
    expect(linearizeActiveLeaf(shuffled).map((r) => r.uuid)).toEqual(["a", "b", "c"])
  })

  it("picks the newest leaf and drops the abandoned branch", () => {
    // a → b(abandoned, older) ; a → c(new, newer) → d
    const recs = [
      node("a", null, "2024-01-01T00:00:01Z"),
      node("b", "a", "2024-01-01T00:00:02Z"), // abandoned edit
      node("c", "a", "2024-01-01T00:00:05Z"), // re-run
      node("d", "c", "2024-01-01T00:00:06Z"),
    ]
    expect(linearizeActiveLeaf(recs).map((r) => r.uuid)).toEqual(["a", "c", "d"])
  })

  it("breaks ties by file order (later leaf wins)", () => {
    const recs = [
      node("a", null, "2024-01-01T00:00:01Z"),
      node("x", "a", "2024-01-01T00:00:02Z"),
      node("y", "a", "2024-01-01T00:00:02Z"), // same ts, later in file
    ]
    expect(linearizeActiveLeaf(recs).map((r) => r.uuid)).toEqual(["a", "y"])
  })

  it("does not hang on a cycle and still terminates", () => {
    // a ↔ b cycle, plus a real leaf c off a
    const recs = [
      node("a", "b", "2024-01-01T00:00:01Z"),
      node("b", "a", "2024-01-01T00:00:02Z"),
      node("c", "a", "2024-01-01T00:00:09Z"),
    ]
    const out = linearizeActiveLeaf(recs)
    // c is the only leaf; walking c→a→b stops when b re-enters a (visited).
    expect(out.map((r) => r.uuid)).toContain("c")
    expect(out.length).toBeLessThanOrEqual(recs.length)
  })

  it("falls back to file order when no node carries a uuid", () => {
    const recs: Rec[] = [
      { parentUuid: null, timestamp: "t1", tag: "x" },
      { parentUuid: null, timestamp: "t2", tag: "y" },
    ]
    expect(linearizeActiveLeaf(recs).map((r) => r.tag)).toEqual(["x", "y"])
  })

  it("treats an orphan parentUuid as a root", () => {
    const recs = [node("b", "ghost", "2024-01-01T00:00:02Z")]
    expect(linearizeActiveLeaf(recs).map((r) => r.uuid)).toEqual(["b"])
  })
})

describe("splitMainAndSidechain", () => {
  it("partitions by isSidechain", () => {
    const recs = [
      node("a", null, "t", { isSidechain: false }),
      node("s", "a", "t", { isSidechain: true }),
      node("b", "a", "t"),
    ]
    const { main, sidechains } = splitMainAndSidechain(recs)
    expect(main.map((r) => r.uuid)).toEqual(["a", "b"])
    expect(sidechains.map((r) => r.uuid)).toEqual(["s"])
  })
})

describe("extractSidechains", () => {
  it("returns [] when there are no sidechains", () => {
    expect(extractSidechains([node("a", null, "t")])).toEqual([])
  })

  it("groups one subagent run and records its spawn parent", () => {
    const recs = [
      node("main1", null, "2024-01-01T00:00:01Z"),
      node("s1", "main1", "2024-01-01T00:00:02Z", { isSidechain: true }),
      node("s2", "s1", "2024-01-01T00:00:03Z", { isSidechain: true }),
    ]
    const groups = extractSidechains(recs)
    expect(groups).toHaveLength(1)
    expect(groups[0].records.map((r) => r.uuid)).toEqual(["s1", "s2"])
    expect(groups[0].rootUuid).toBe("s1")
    expect(groups[0].spawnParentUuid).toBe("main1")
  })

  it("separates two subagents spawned from the same turn", () => {
    const recs = [
      node("main1", null, "2024-01-01T00:00:01Z"),
      node("a1", "main1", "2024-01-01T00:00:02Z", { isSidechain: true }),
      node("a2", "a1", "2024-01-01T00:00:03Z", { isSidechain: true }),
      node("b1", "main1", "2024-01-01T00:00:04Z", { isSidechain: true }),
    ]
    const groups = extractSidechains(recs)
    expect(groups).toHaveLength(2)
    expect(groups.map((g) => g.rootUuid).sort()).toEqual(["a1", "b1"])
  })

  it("treats an orphan sidechain (no back-edge) as its own group", () => {
    const recs = [node("orphan", null, "t", { isSidechain: true })]
    const groups = extractSidechains(recs)
    expect(groups).toHaveLength(1)
    expect(groups[0].spawnParentUuid).toBeUndefined()
  })
})
