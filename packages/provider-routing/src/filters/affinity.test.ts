import { affinityFilter } from "./affinity"
import type { FilterContext, FilterRequest } from "@cognia/provider-types/deployment-filter"
import type { ModelMappingEntry } from "@cognia/provider-types/model-mapping"

const entries: ModelMappingEntry[] = [
  { providerId: "a", modelId: "m1" },
  { providerId: "b", modelId: "m2" },
  { providerId: "c", modelId: "m3" },
]

function ctx(partial: Partial<FilterContext> = {}): FilterContext {
  return {
    telemetry: {
      getHealthMetrics: () => undefined,
      getPricing: () => undefined,
      getInFlight: () => 0,
      now: () => 0,
    },
    getCircuitBreakerState: () => "closed",
    isAvailable: () => true,
    constraints: [],
    now: () => 0,
    ...partial,
  }
}

const reqFor = (sessionId?: string): FilterRequest => ({ alias: "alias", sessionId })

describe("affinityFilter", () => {
  it("is inert without a sessionId or pin lookup", () => {
    expect(affinityFilter.filter(entries, reqFor(undefined), ctx()).notes).toBeUndefined()
    expect(
      affinityFilter.filter(entries, reqFor("s1"), ctx()).candidates.map((e) => e.providerId)
    ).toEqual(["a", "b", "c"])
  })

  it("is inert when the session has no pin", () => {
    const out = affinityFilter.filter(
      entries,
      reqFor("s1"),
      ctx({ getSessionDeployment: () => undefined })
    )
    expect(out.notes).toBeUndefined()
  })

  it("moves a healthy pinned deployment to the front (soft pin)", () => {
    const out = affinityFilter.filter(
      entries,
      reqFor("s1"),
      ctx({ getSessionDeployment: () => "b::m2" })
    )
    expect(out.candidates.map((e) => e.providerId)).toEqual(["b", "a", "c"])
    expect(out.notes?.affinityPinned).toBe("b::m2")
  })

  it("keeps the order when the pin is already first", () => {
    const out = affinityFilter.filter(
      entries,
      reqFor("s1"),
      ctx({ getSessionDeployment: () => "a::m1" })
    )
    expect(out.candidates.map((e) => e.providerId)).toEqual(["a", "b", "c"])
    expect(out.notes?.affinityPinned).toBe("a::m1")
  })

  it("matches a provider-only wildcard pin against any model of that provider", () => {
    const out = affinityFilter.filter(
      entries,
      reqFor("s1"),
      ctx({ getSessionDeployment: () => "b::*" })
    )
    expect(out.candidates.map((e) => e.providerId)).toEqual(["b", "a", "c"])
    expect(out.notes?.affinityPinned).toBe("b::*")
  })

  it("ignores a wildcard pin whose provider is not in the pool", () => {
    const out = affinityFilter.filter(
      entries,
      reqFor("s1"),
      ctx({ getSessionDeployment: () => "zzz::*" })
    )
    expect(out.notes).toBeUndefined()
  })

  it("ignores an unparseable pin key", () => {
    const out = affinityFilter.filter(
      entries,
      reqFor("s1"),
      ctx({ getSessionDeployment: () => "nocolon" })
    )
    expect(out.notes).toBeUndefined()
  })

  it("ignores a pin outside the candidate pool (pin kept)", () => {
    const released: string[] = []
    const out = affinityFilter.filter(
      entries,
      reqFor("s1"),
      ctx({
        getSessionDeployment: () => "elsewhere::x",
        releaseSessionDeployment: (s) => released.push(s),
      })
    )
    expect(out.notes).toBeUndefined()
    expect(released).toEqual([])
  })

  it("releases the pin when its deployment breaker is open", () => {
    const released: string[] = []
    const out = affinityFilter.filter(
      entries,
      reqFor("s1"),
      ctx({
        getSessionDeployment: () => "b::m2",
        getCircuitBreakerState: (e) => (e.providerId === "b" ? "open" : "closed"),
        releaseSessionDeployment: (s) => released.push(s),
      })
    )
    expect(out.candidates.map((e) => e.providerId)).toEqual(["a", "b", "c"])
    expect(out.notes).toBeUndefined()
    expect(released).toEqual(["s1"])
  })

  it("releases the pin when its provider is unavailable", () => {
    const released: string[] = []
    affinityFilter.filter(
      entries,
      reqFor("s1"),
      ctx({
        getSessionDeployment: () => "b::m2",
        isAvailable: (e) => e.providerId !== "b",
        releaseSessionDeployment: (s) => released.push(s),
      })
    )
    expect(released).toEqual(["s1"])
  })
})
