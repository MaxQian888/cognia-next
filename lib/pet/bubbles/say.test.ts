import { DEFAULT_SAY_DURATION_MS, sayAsPet, type SayDeps } from "./say"
import { usePetStore } from "@/stores/pet/pet-store"

const T0 = 1_700_000_000_000

let bubbles: Array<{ text: string; origin: string } | null>
let shots: string[]
let scheduled: Array<{ fn: () => void; ms: number }>

function deps(over: Partial<SayDeps> = {}): SayDeps {
  return {
    now: () => T0,
    setBubble: (b) => {
      bubbles.push(b)
    },
    enqueueOneShot: (s) => {
      shots.push(s)
    },
    schedule: (fn, ms) => {
      scheduled.push({ fn, ms })
    },
    limiter: { tryAcquire: () => true },
    ...over,
  }
}

beforeEach(() => {
  bubbles = []
  shots = []
  scheduled = []
  usePetStore.setState({ bubble: null })
})

describe("sayAsPet", () => {
  it("puts a sanitized line in the bubble and schedules its own clear", () => {
    const res = sayAsPet('  "Hello there"  ', {}, deps())
    expect(res).toEqual({ ok: true, text: "Hello there", clearsAt: T0 + DEFAULT_SAY_DURATION_MS })
    expect(bubbles).toEqual([{ text: "Hello there", origin: "llm" }])
    expect(scheduled[0].ms).toBe(DEFAULT_SAY_DURATION_MS)
  })

  it("plays a flourish alongside the line when asked", () => {
    sayAsPet("yay", { emotion: "love" }, deps())
    expect(shots).toEqual(["love"])
  })

  it("clamps the duration to a sane window", () => {
    sayAsPet("a", { durationMs: 1 }, deps())
    expect(scheduled[0].ms).toBe(1000)
    scheduled = []
    sayAsPet("b", { durationMs: 999_999 }, deps())
    expect(scheduled[0].ms).toBe(15000)
  })

  it("refuses text carrying PII before it can reach the screen", () => {
    expect(sayAsPet("your SSN is 123-45-6789", {}, deps())).toEqual({ ok: false, reason: "pii" })
    expect(bubbles).toEqual([])
  })

  it("refuses an empty line rather than flashing a blank bubble", () => {
    expect(sayAsPet("   ", {}, deps())).toEqual({ ok: false, reason: "empty" })
    expect(bubbles).toEqual([])
  })

  it("spends the shared speak limiter, so it cannot out-talk the user", () => {
    const res = sayAsPet("hi", {}, deps({ limiter: { tryAcquire: () => false } }))
    expect(res).toEqual({ ok: false, reason: "rate-limited" })
    expect(bubbles).toEqual([])
  })

  it("stays silent when bubbles are muted", () => {
    expect(sayAsPet("hi", {}, deps({ muted: true }))).toEqual({ ok: false, reason: "muted" })
    expect(bubbles).toEqual([])
  })

  it("does not cut a newer bubble short when its own timer fires", () => {
    sayAsPet("first", {}, deps())
    usePetStore.setState({ bubble: { text: "second", origin: "llm" } })
    bubbles = []
    scheduled[0].fn()
    expect(bubbles).toEqual([])
  })

  it("clears its own bubble when the timer fires and nothing replaced it", () => {
    const realStoreDeps = deps({ setBubble: (b) => usePetStore.getState().setBubble(b) })
    sayAsPet("only me", {}, realStoreDeps)
    expect(usePetStore.getState().bubble?.text).toBe("only me")
    scheduled[0].fn()
    expect(usePetStore.getState().bubble).toBeNull()
  })
})
