import { runDispatchFanout, type DispatchCoreOutcome } from "./dispatch-core"
import type { NormalizedDispatch } from "./dispatch-agent-tool"

function d(id: string): NormalizedDispatch {
  return { subagentId: id, prompt: `do ${id}`, toolsEnabled: false, background: false }
}

const ok = (text: string): DispatchCoreOutcome => ({ text, ok: true })

describe("runDispatchFanout", () => {
  it("runs a single dispatch without the pool and uses the bare id label", async () => {
    const labels: string[] = []
    const out = await runDispatchFanout({
      dispatches: [d("solo")],
      width: 1,
      runOne: async (dispatch, label) => {
        labels.push(label)
        return ok(`ran ${dispatch.subagentId}`)
      },
    })
    expect(out).toEqual([ok("ran solo")])
    expect(labels).toEqual(["solo"]) // single → no #N suffix
  })

  it("preserves input order regardless of completion order", async () => {
    const out = await runDispatchFanout({
      dispatches: [d("a"), d("b"), d("c")],
      width: Infinity,
      runOne: async (dispatch) => {
        // c finishes first, a last — output must still be a,b,c.
        const delay = { a: 15, b: 8, c: 0 }[dispatch.subagentId] ?? 0
        await new Promise((r) => setTimeout(r, delay))
        return ok(dispatch.subagentId)
      },
    })
    expect(out.map((o) => o.text)).toEqual(["a", "b", "c"])
  })

  it("width=1 runs strictly serially (never two in flight)", async () => {
    let inFlight = 0
    let maxInFlight = 0
    await runDispatchFanout({
      dispatches: [d("a"), d("b"), d("c")],
      width: 1,
      runOne: async (dispatch) => {
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise((r) => setTimeout(r, 5))
        inFlight--
        return ok(dispatch.subagentId)
      },
    })
    expect(maxInFlight).toBe(1)
  })

  it("bounds concurrency to `width` (never more than the cap in flight)", async () => {
    let inFlight = 0
    let maxInFlight = 0
    await runDispatchFanout({
      dispatches: [d("a"), d("b"), d("c"), d("d"), d("e")],
      width: 2,
      runOne: async (dispatch) => {
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise((r) => setTimeout(r, 5))
        inFlight--
        return ok(dispatch.subagentId)
      },
    })
    expect(maxInFlight).toBe(2)
  })

  it("full parallel (width=Infinity) starts every sibling at once", async () => {
    let inFlight = 0
    let maxInFlight = 0
    await runDispatchFanout({
      dispatches: [d("a"), d("b"), d("c")],
      width: Infinity,
      runOne: async (dispatch) => {
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise((r) => setTimeout(r, 5))
        inFlight--
        return ok(dispatch.subagentId)
      },
    })
    expect(maxInFlight).toBe(3)
  })

  it("shouldStop short-circuits not-yet-started dispatches to a skipped outcome", async () => {
    let ran = 0
    const out = await runDispatchFanout({
      dispatches: [d("a"), d("b"), d("c")],
      width: 1,
      // Stop after the first has run.
      shouldStop: () => ran >= 1,
      runOne: async (dispatch) => {
        ran++
        return ok(dispatch.subagentId)
      },
    })
    expect(out[0]).toEqual(ok("a"))
    expect(out[1].ok).toBe(false)
    expect(out[1].text).toMatch(/skipped/)
    expect(out[2].ok).toBe(false)
    expect(ran).toBe(1) // b and c never ran
  })

  it("uses a custom labelFor and skippedText when provided", async () => {
    const out = await runDispatchFanout({
      dispatches: [d("a"), d("b")],
      width: 1,
      shouldStop: () => true,
      labelFor: (dispatch, i) => `L-${dispatch.subagentId}-${i}`,
      skippedText: (_dispatch, label) => `${label}: no budget`,
      runOne: async () => ok("unreached"),
    })
    expect(out[0].text).toBe("L-a-0: no budget")
    expect(out[1].text).toBe("L-b-1: no budget")
  })

  it("treats width < 1 as serial", async () => {
    let inFlight = 0
    let maxInFlight = 0
    await runDispatchFanout({
      dispatches: [d("a"), d("b")],
      width: 0,
      runOne: async (dispatch) => {
        inFlight++
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise((r) => setTimeout(r, 5))
        inFlight--
        return ok(dispatch.subagentId)
      },
    })
    expect(maxInFlight).toBe(1)
  })
})
