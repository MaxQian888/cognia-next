/**
 * @jest-environment node
 */
import { createMentionLoader, MENTION_DEBOUNCE_MS } from "./async-load"
import type { MentionCandidate } from "./types"

function cand(id: string): MentionCandidate {
  return { kind: "skill", id, label: id, insert: `@skill:${id}` }
}

beforeEach(() => jest.useFakeTimers())
afterEach(() => {
  jest.runOnlyPendingTimers()
  jest.useRealTimers()
})

describe("createMentionLoader", () => {
  it("emits loading=true immediately and the result after the debounce", async () => {
    const load = jest.fn(async (key: string) => [cand(key)])
    const loader = createMentionLoader(load)
    const results: Array<{ loading: boolean; ids: string[] }> = []
    loader.request("a", (r) =>
      results.push({ loading: r.loading, ids: r.candidates.map((c) => c.id) })
    )

    expect(results[0]).toEqual({ loading: true, ids: [] })
    expect(load).not.toHaveBeenCalled()

    await jest.advanceTimersByTimeAsync(MENTION_DEBOUNCE_MS)
    expect(load).toHaveBeenCalledTimes(1)
    expect(results[1]).toEqual({ loading: false, ids: ["a"] })
  })

  it("coalesces rapid requests to a single load for the latest key", async () => {
    const load = jest.fn(async (key: string) => [cand(key)])
    const loader = createMentionLoader(load)
    const results: Array<{ loading: boolean; ids: string[] }> = []
    const sink = (r: { loading: boolean; candidates: MentionCandidate[] }) =>
      results.push({ loading: r.loading, ids: r.candidates.map((c) => c.id) })

    loader.request("a", sink)
    loader.request("ab", sink)
    loader.request("abc", sink)

    await jest.advanceTimersByTimeAsync(MENTION_DEBOUNCE_MS)
    expect(load).toHaveBeenCalledTimes(1)
    expect(load).toHaveBeenCalledWith("abc")
    expect(results.at(-1)).toEqual({ loading: false, ids: ["abc"] })
  })

  it("drops a stale load that resolves after a newer request", async () => {
    let resolveFirst: (v: MentionCandidate[]) => void = () => {}
    const load = jest
      .fn()
      .mockImplementationOnce(() => new Promise<MentionCandidate[]>((res) => (resolveFirst = res)))
      .mockImplementationOnce(async () => [cand("fast")])
    const loader = createMentionLoader(load)
    const settled: string[][] = []
    const sink = (r: { loading: boolean; candidates: MentionCandidate[] }) => {
      if (!r.loading) settled.push(r.candidates.map((c) => c.id))
    }

    loader.request("slow", sink)
    await jest.advanceTimersByTimeAsync(MENTION_DEBOUNCE_MS) // first load starts (pending)

    loader.request("fast", sink)
    await jest.advanceTimersByTimeAsync(MENTION_DEBOUNCE_MS) // second load resolves
    expect(settled).toEqual([["fast"]])

    // Late resolution of the first (stale) load must be ignored.
    resolveFirst([cand("slow")])
    await Promise.resolve()
    expect(settled).toEqual([["fast"]])
  })

  it("emits an empty result when the load rejects", async () => {
    const load = jest.fn(async () => {
      throw new Error("boom")
    })
    const loader = createMentionLoader(load)
    const settled: string[][] = []
    loader.request("x", (r) => {
      if (!r.loading) settled.push(r.candidates.map((c) => c.id))
    })
    await jest.advanceTimersByTimeAsync(MENTION_DEBOUNCE_MS)
    expect(settled).toEqual([[]])
  })

  it("cancel() drops a pending load", async () => {
    const load = jest.fn(async () => [cand("a")])
    const loader = createMentionLoader(load)
    loader.request("a", () => {})
    loader.cancel()
    await jest.advanceTimersByTimeAsync(MENTION_DEBOUNCE_MS * 2)
    expect(load).not.toHaveBeenCalled()
  })
})
