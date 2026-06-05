// Coverage for the per-provider trailing-minute rate store.

import { useRateLimitStore } from "./rate-limit-store"
import { RATE_WINDOW_MS } from "@/lib/ai/providers/rate-limit-window"

const T0 = 5_000_000

beforeEach(() => {
  useRateLimitStore.getState().reset()
})

describe("useRateLimitStore", () => {
  it("records requests per provider and reports rpm/tpm", () => {
    const s = useRateLimitStore.getState()
    s.record("openai", 100, T0)
    s.record("openai", 200, T0 + 1000)
    s.record("groq", 50, T0 + 1000)

    expect(useRateLimitStore.getState().getRate("openai", T0 + 2000)).toEqual({
      rpm: 2,
      tpm: 300,
    })
    expect(useRateLimitStore.getState().getRate("groq", T0 + 2000)).toEqual({ rpm: 1, tpm: 50 })
  })

  it("counts a request with unknown tokens as rpm-only", () => {
    const s = useRateLimitStore.getState()
    s.record("openai", undefined, T0)
    expect(useRateLimitStore.getState().getRate("openai", T0 + 1)).toEqual({ rpm: 1, tpm: 0 })
  })

  it("ages events out of the window", () => {
    const s = useRateLimitStore.getState()
    s.record("openai", 100, T0)
    expect(useRateLimitStore.getState().getRate("openai", T0 + RATE_WINDOW_MS + 1)).toEqual({
      rpm: 0,
      tpm: 0,
    })
  })

  it("ignores empty provider ids and resets cleanly", () => {
    const s = useRateLimitStore.getState()
    s.record("", 100, T0)
    expect(useRateLimitStore.getState().events).toEqual({})
    s.record("openai", 100, T0)
    useRateLimitStore.getState().reset()
    expect(useRateLimitStore.getState().getRate("openai", T0 + 1)).toEqual({ rpm: 0, tpm: 0 })
  })
})
