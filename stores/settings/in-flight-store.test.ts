import { useInFlightStore } from "./in-flight-store"

describe("in-flight store", () => {
  beforeEach(() => {
    useInFlightStore.getState().__resetForTesting()
  })

  it("counts concurrent sessions per provider", () => {
    const store = useInFlightStore.getState()
    store.begin("s1", "openai")
    store.begin("s2", "openai")
    store.begin("s3", "anthropic")
    expect(useInFlightStore.getState().getInFlight("openai")).toBe(2)
    expect(useInFlightStore.getState().getInFlight("anthropic")).toBe(1)
    expect(useInFlightStore.getState().getInFlight("ghost")).toBe(0)
  })

  it("settle is idempotent and unknown sessions are no-ops", () => {
    const store = useInFlightStore.getState()
    store.begin("s1", "openai")
    store.settle("s1")
    store.settle("s1")
    store.settle("never-began")
    expect(useInFlightStore.getState().getInFlight("openai")).toBe(0)
  })

  it("a fallback re-issue moves the session's count to the new provider", () => {
    const store = useInFlightStore.getState()
    store.begin("s1", "openai")
    store.begin("s1", "anthropic") // retry against next chain entry
    expect(useInFlightStore.getState().getInFlight("openai")).toBe(0)
    expect(useInFlightStore.getState().getInFlight("anthropic")).toBe(1)
    store.settle("s1")
    expect(useInFlightStore.getState().getInFlight("anthropic")).toBe(0)
  })

  it("ignores blank ids and never goes negative", () => {
    const store = useInFlightStore.getState()
    store.begin("", "openai")
    store.begin("s1", "")
    expect(useInFlightStore.getState().getInFlight("openai")).toBe(0)
    store.begin("s1", "openai")
    store.settle("s1")
    store.settle("s1")
    expect(useInFlightStore.getState().getInFlight("openai")).toBe(0)
  })

  describe("deployment granularity", () => {
    it("tracks per-deployment counts and sums to the provider", () => {
      const store = useInFlightStore.getState()
      store.begin("s1", "openai", { modelId: "gpt-4o" })
      store.begin("s2", "openai", { modelId: "gpt-4o-mini" })
      store.begin("s3", "openai", { modelId: "gpt-4o" })
      const st = useInFlightStore.getState()
      expect(st.getDeploymentInFlight("openai::gpt-4o")).toBe(2)
      expect(st.getDeploymentInFlight("openai::gpt-4o-mini")).toBe(1)
      expect(st.getInFlight("openai")).toBe(3)
    })

    it("provider-only begins land in the wildcard deployment", () => {
      const store = useInFlightStore.getState()
      store.begin("s1", "openai")
      const st = useInFlightStore.getState()
      expect(st.getDeploymentInFlight("openai::*")).toBe(1)
      expect(st.getInFlight("openai")).toBe(1)
    })

    it("a retry against another deployment of the SAME provider moves the count", () => {
      const store = useInFlightStore.getState()
      store.begin("s1", "openai", { modelId: "gpt-4o" })
      store.begin("s1", "openai", { modelId: "gpt-4o-mini" })
      const st = useInFlightStore.getState()
      expect(st.getDeploymentInFlight("openai::gpt-4o")).toBe(0)
      expect(st.getDeploymentInFlight("openai::gpt-4o-mini")).toBe(1)
      expect(st.getInFlight("openai")).toBe(1)
    })

    it("keyId separates deployment counts", () => {
      const store = useInFlightStore.getState()
      store.begin("s1", "openai", { modelId: "gpt-4o", keyId: "k1" })
      store.begin("s2", "openai", { modelId: "gpt-4o", keyId: "k2" })
      const st = useInFlightStore.getState()
      expect(st.getDeploymentInFlight("openai::gpt-4o::k1")).toBe(1)
      expect(st.getDeploymentInFlight("openai::gpt-4o::k2")).toBe(1)
      expect(st.getInFlight("openai")).toBe(2)
    })
  })
})
