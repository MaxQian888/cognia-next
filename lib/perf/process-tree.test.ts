import type { ProcessSample } from "./backend/types"
import { buildProcessTree, filterProcessTree } from "./process-tree"

const proc = (pid: number, parentPid: number | null, name: string, cpuPct = 0): ProcessSample => ({
  pid,
  parentPid,
  name,
  role: pid === 1 ? "main" : "child",
  cpuPct,
  cpuPctRaw: cpuPct,
  memBytes: 0,
  diskReadBps: 0,
  diskWriteBps: 0,
  runSecs: 1,
})

describe("process tree", () => {
  it("retains ancestors during filtering and sorts siblings independently", () => {
    const roots = buildProcessTree([
      proc(3, 1, "z-child", 2),
      proc(1, null, "root"),
      proc(4, 2, "needle", 8),
      proc(2, 1, "a-child", 9),
    ])
    expect(roots[0].children.map((node) => node.process.pid)).toEqual([2, 3])
    const filtered = filterProcessTree(roots, "needle")
    expect(filtered[0].process.pid).toBe(1)
    expect(filtered[0].children[0].process.pid).toBe(2)
    expect(filtered[0].children[0].children[0].process.pid).toBe(4)
  })

  it("keeps orphans visible and breaks parent cycles", () => {
    const roots = buildProcessTree([proc(7, 99, "orphan"), proc(8, 9, "a"), proc(9, 8, "b")])
    expect(
      roots.flatMap((node) => [node.process.pid, ...node.children.map((c) => c.process.pid)])
    ).toEqual(expect.arrayContaining([7, 8, 9]))
  })
})
