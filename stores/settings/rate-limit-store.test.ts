// Coverage for the per-provider trailing-minute rate store.

import { useRateLimitStore } from "./rate-limit-store"
import { RATE_WINDOW_MS } from "@cognia/provider-core/providers/rate-limit-window"

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

  describe("deployment granularity", () => {
    it("tracks per-deployment windows and merges to the provider", () => {
      const s = useRateLimitStore.getState()
      s.record("openai", 100, T0, { modelId: "gpt-4o" })
      s.record("openai", 200, T0 + 100, { modelId: "gpt-4o-mini" })
      const st = useRateLimitStore.getState()
      expect(st.getDeploymentRate("openai::gpt-4o", T0 + 200)).toEqual({ rpm: 1, tpm: 100 })
      expect(st.getDeploymentRate("openai::gpt-4o-mini", T0 + 200)).toEqual({ rpm: 1, tpm: 200 })
      expect(st.getRate("openai", T0 + 200)).toEqual({ rpm: 2, tpm: 300 })
    })

    it("provider-only records land in the wildcard deployment", () => {
      const s = useRateLimitStore.getState()
      s.record("openai", 50, T0)
      expect(useRateLimitStore.getState().getDeploymentRate("openai::*", T0 + 1)).toEqual({
        rpm: 1,
        tpm: 50,
      })
    })

    it("keyId separates deployment windows", () => {
      const s = useRateLimitStore.getState()
      s.record("openai", 10, T0, { modelId: "gpt-4o", keyId: "k1" })
      s.record("openai", 20, T0, { modelId: "gpt-4o", keyId: "k2" })
      const st = useRateLimitStore.getState()
      expect(st.getDeploymentRate("openai::gpt-4o::k1", T0 + 1)).toEqual({ rpm: 1, tpm: 10 })
      expect(st.getDeploymentRate("openai::gpt-4o::k2", T0 + 1)).toEqual({ rpm: 1, tpm: 20 })
      expect(st.getRate("openai", T0 + 1)).toEqual({ rpm: 2, tpm: 30 })
    })

    it("unknown deployments report a zero rate", () => {
      expect(useRateLimitStore.getState().getDeploymentRate("ghost::m", T0)).toEqual({
        rpm: 0,
        tpm: 0,
      })
    })
  })
})
