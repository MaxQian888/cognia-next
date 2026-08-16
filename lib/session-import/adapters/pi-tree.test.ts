import { piActiveChain, piAlternateLeafIds, piChainToLeaf } from "./pi-tree"

interface Node {
  id?: string
  parentId?: string | null
  timestamp?: string
}

const n = (id: string, parentId: string | null, ts: string): Node => ({
  id,
  parentId,
  timestamp: ts,
})

/**
 *        a ── b ── c        (newest leaf: c)
 *             └─── d ── e   (older branch)
 */
const forked: Node[] = [
  n("a", null, "2026-08-14T10:00:00Z"),
  n("b", "a", "2026-08-14T10:01:00Z"),
  n("d", "b", "2026-08-14T10:02:00Z"),
  n("e", "d", "2026-08-14T10:03:00Z"),
  n("c", "b", "2026-08-14T10:09:00Z"),
]

describe("piActiveChain", () => {
  it("walks the newest leaf back to the root", () => {
    expect(piActiveChain(forked).map((x) => x.id)).toEqual(["a", "b", "c"])
  })

  it("keeps a linear session intact", () => {
    const linear = [n("a", null, "1"), n("b", "a", "2"), n("c", "b", "3")]
    expect(piActiveChain(linear).map((x) => x.id)).toEqual(["a", "b", "c"])
  })

  /**
   * v1 session files predate `id`/`parentId`. They must still import in file
   * order rather than collapsing to nothing.
   */
  it("falls back to file order when no entry carries an id", () => {
    const legacy = [{ timestamp: "1" }, { timestamp: "2" }] as Node[]
    expect(piActiveChain(legacy)).toHaveLength(2)
  })

  it("does not hang on a parent cycle", () => {
    const cyclic = [n("a", "b", "1"), n("b", "a", "2")]
    expect(() => piActiveChain(cyclic)).not.toThrow()
  })
})

describe("piAlternateLeafIds", () => {
  it("finds branches the active chain abandoned", () => {
    // `e` is reachable in Pi's /tree, so dropping it would lose real work.
    expect(piAlternateLeafIds(forked)).toEqual(["e"])
  })

  it("returns nothing for a linear session", () => {
    expect(piAlternateLeafIds([n("a", null, "1"), n("b", "a", "2")])).toEqual([])
  })

  it("orders multiple branches newest first", () => {
    const many = [
      n("a", null, "2026-08-14T10:00:00Z"),
      n("x", "a", "2026-08-14T10:01:00Z"),
      n("y", "a", "2026-08-14T10:05:00Z"),
      n("z", "a", "2026-08-14T10:09:00Z"),
    ]
    // `z` is the active leaf; the rest are alternates, newest first.
    expect(piAlternateLeafIds(many)).toEqual(["y", "x"])
  })

  it("ignores entries with no id", () => {
    expect(piAlternateLeafIds([{ timestamp: "1" }] as Node[])).toEqual([])
  })
})

describe("piChainToLeaf", () => {
  it("returns the root→leaf path for a specific branch", () => {
    expect(piChainToLeaf(forked, "e").map((x) => x.id)).toEqual(["a", "b", "d", "e"])
  })

  it("returns nothing for an unknown leaf", () => {
    expect(piChainToLeaf(forked, "nope")).toEqual([])
  })

  it("stops at a dangling parent instead of failing", () => {
    const dangling = [n("b", "missing", "1")]
    expect(piChainToLeaf(dangling, "b").map((x) => x.id)).toEqual(["b"])
  })

  it("does not hang on a parent cycle", () => {
    const cyclic = [n("a", "b", "1"), n("b", "a", "2")]
    const chain = piChainToLeaf(cyclic, "a")
    expect(chain.length).toBeLessThanOrEqual(2)
  })
})
