import { combineAbortSignals } from "./abort"

describe("combineAbortSignals", () => {
  it("returns undefined without a signal and preserves a single signal", () => {
    expect(combineAbortSignals(undefined, null)).toBeUndefined()
    const controller = new AbortController()
    expect(combineAbortSignals(controller.signal)?.signal).toBe(controller.signal)
  })

  it("aborts when the first input aborts", () => {
    const first = new AbortController()
    const second = new AbortController()
    const combined = combineAbortSignals(first.signal, second.signal)!

    second.abort()

    expect(combined.signal.aborted).toBe(true)
    combined.cleanup()
  })

  it("starts aborted when an input already aborted", () => {
    const first = new AbortController()
    first.abort()

    expect(combineAbortSignals(first.signal, new AbortController().signal)?.signal.aborted).toBe(
      true
    )
  })
})
