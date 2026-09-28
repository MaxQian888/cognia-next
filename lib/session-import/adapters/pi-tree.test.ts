import { piActiveChain, piAlternateLeafIds, piChainToLeaf, piSessionTree } from "./pi-tree"

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

describe("piSessionTree", () => {
  it.each([
    forked,
    [] as Node[],
    [{ timestamp: "1" }, { timestamp: "2" }],
    [n("a", "b", "1"), n("b", "a", "2")],
    [n("a", null, "bad"), n("b", "missing", "bad")],
    [n("a", null, "1"), n("b", "a", "2"), n("b", "missing", "3")],
  ])("preserves standalone helper behavior for tree %#", (...entries) => {
    const tree = piSessionTree(entries)
    expect(tree.activeChain).toEqual(piActiveChain(entries))
    expect(tree.alternateLeafIds).toEqual(piAlternateLeafIds(entries))
    for (const leaf of [...tree.alternateLeafIds, "a", "missing"]) {
      expect(tree.chainToLeaf(leaf)).toEqual(piChainToLeaf(entries, leaf))
    }
  })

  it("does not re-index the transcript for each alternate leaf", () => {
    let idReads = 0
    const entries = Array.from({ length: 1000 }, (_, i) => ({
      get id() {
        idReads++
        return `e${i}`
      },
      parentId: i === 0 ? null : "e0",
      timestamp: "2026-01-01T00:00:00Z",
    }))
    const tree = piSessionTree(entries)
    idReads = 0
    for (const leaf of tree.alternateLeafIds) expect(tree.chainToLeaf(leaf)).toHaveLength(2)
    expect(idReads).toBe(0)
  })

  it("builds an independent index for each new snapshot", () => {
    const first = piSessionTree(forked)
    const edited = [...forked, n("later", "c", "2026-08-15T00:00:00Z")]
    expect(piSessionTree(edited).activeChain.at(-1)?.id).toBe("later")
    expect(first.activeChain.at(-1)?.id).toBe("c")
  })
})
