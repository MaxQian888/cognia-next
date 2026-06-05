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
})
