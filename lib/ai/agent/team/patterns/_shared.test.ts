import {
  nonRetryable,
  getTeamCtxOrThrow,
  fanoutLimit,
  mapSettled,
  collectUpstreamArray,
  firstUpstream,
  collectFindings,
  assignFindingIds,
  dedupeFindings,
  renderFinding,
} from "./_shared"
import {
  registerTeamRunContext,
  unregisterTeamRunContext,
  __resetTeamRunContextForTesting,
  type TeamRunContext,
} from "../team-run-context"
import type { StepExecutionContext } from "@/types/workflow/visual"
import type { Finding } from "@/types/agent/ultracode"

afterEach(() => __resetTeamRunContextForTesting())

describe("nonRetryable", () => {
  it("flags the error as non-retryable", () => {
    const err = nonRetryable("nope") as Error & { retryable?: boolean }
    expect(err.message).toBe("nope")
    expect(err.retryable).toBe(false)
  })
})

describe("getTeamCtxOrThrow", () => {
  it("returns the registered context", () => {
    const fake = { runId: "r1", concurrency: { get: () => 4 } } as unknown as TeamRunContext
    registerTeamRunContext(fake)
    const ctx = { runId: "r1" } as StepExecutionContext
    expect(getTeamCtxOrThrow(ctx)).toBe(fake)
    unregisterTeamRunContext("r1")
  })

  it("throws non-retryable when missing", () => {
    const ctx = { runId: "missing" } as StepExecutionContext
    expect(() => getTeamCtxOrThrow(ctx)).toThrow(/no TeamRunContext/)
  })
})

describe("fanoutLimit", () => {
  it("never returns below 1", () => {
    expect(fanoutLimit({ concurrency: { get: () => 0 } } as unknown as TeamRunContext)).toBe(1)
    expect(fanoutLimit({ concurrency: { get: () => 5 } } as unknown as TeamRunContext)).toBe(5)
  })
})

describe("mapSettled", () => {
  it("runs all items and preserves order", async () => {
    const out = await mapSettled([1, 2, 3], 2, async (n) => n * 10)
    expect(out).toEqual([10, 20, 30])
  })

  it("caps in-flight work to the limit", async () => {
    let inFlight = 0
    let peak = 0
    await mapSettled([1, 2, 3, 4, 5], 2, async () => {
      inFlight += 1
      peak = Math.max(peak, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight -= 1
    })
    expect(peak).toBeLessThanOrEqual(2)
  })

  it("captures per-item rejections as null and calls onError", async () => {
    const onError = jest.fn()
    const out = await mapSettled(
      [1, 2, 3],
      3,
      async (n) => {
        if (n === 2) throw new Error("bad")
        return n
      },
      onError
    )
    expect(out).toEqual([1, null, 3])
    expect(onError).toHaveBeenCalledTimes(1)
  })
})

describe("upstream collectors", () => {
  const upstream = {
    nodeA: { findings: [{ title: "x", detail: "d" }] },
    nodeB: { findings: [{ title: "y", detail: "e" }], winner: { attempt: { angle: "a" } } },
    nodeC: { gaps: [{ description: "g1" }] },
    nodeD: null,
  }

  it("collectUpstreamArray flattens a field across nodes", () => {
    expect(collectUpstreamArray(upstream, "findings")).toHaveLength(2)
    expect(collectUpstreamArray(upstream, "gaps")).toEqual([{ description: "g1" }])
  })

  it("firstUpstream returns the first present value", () => {
    expect(firstUpstream(upstream, "winner")).toEqual({ attempt: { angle: "a" } })
    expect(firstUpstream(upstream, "missing")).toBeUndefined()
  })

  it("collectFindings dedupes + assigns ids", () => {
    const found = collectFindings(upstream)
    expect(found).toHaveLength(2)
    expect(found.every((f) => !!f.id)).toBe(true)
  })
})

describe("finding helpers", () => {
  it("assignFindingIds only fills missing ids", () => {
    const out = assignFindingIds([
      { id: "keep", title: "a", detail: "b" },
      { title: "c", detail: "d" },
    ])
    expect(out[0].id).toBe("keep")
    expect(out[1].id).toBeTruthy()
  })

  it("dedupeFindings collapses same-key findings", () => {
    const found: Finding[] = [
      { title: "Bug", detail: "x", location: "a.ts:1" },
      { title: "Bug2", detail: "y", location: "a.ts:1" },
      { title: "Bug3", detail: "z", location: "b.ts:2" },
    ]
    expect(dedupeFindings(found)).toHaveLength(2)
  })

  it("renderFinding includes severity + location when present", () => {
    expect(renderFinding({ title: "T", detail: "D", location: "f:1", severity: "high" })).toBe(
      "[high] T (f:1): D"
    )
    expect(renderFinding({ title: "T", detail: "D" })).toBe("T: D")
  })
})
