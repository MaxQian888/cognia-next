import {
  __resetForTesting,
  DEFAULT_AFFINITY_TTL_MS,
  getSessionDeployment,
  pinSessionDeployment,
  releaseSessionDeployment,
} from "./session-affinity-store"

describe("session affinity store", () => {
  beforeEach(() => __resetForTesting())

  it("returns the pinned deployment while fresh", () => {
    pinSessionDeployment("s1", "openai::gpt-4o", 1000)
    expect(getSessionDeployment("s1", 1000 + 60_000)).toBe("openai::gpt-4o")
  })

  it("re-pinning replaces the previous deployment", () => {
    pinSessionDeployment("s1", "openai::gpt-4o", 1000)
    pinSessionDeployment("s1", "groq::llama-3.3-70b", 2000)
    expect(getSessionDeployment("s1", 3000)).toBe("groq::llama-3.3-70b")
  })

  it("expires after the TTL and clears the stale pin", () => {
    pinSessionDeployment("s1", "openai::gpt-4o", 1000)
    expect(getSessionDeployment("s1", 1000 + DEFAULT_AFFINITY_TTL_MS + 1)).toBeUndefined()
    // The expired pin was deleted, not just hidden.
    expect(getSessionDeployment("s1", 1000)).toBeUndefined()
  })

  it("honors a custom TTL", () => {
    pinSessionDeployment("s1", "openai::gpt-4o", 1000)
    expect(getSessionDeployment("s1", 6000, 1000)).toBeUndefined()
  })

  it("release removes the pin", () => {
    pinSessionDeployment("s1", "openai::gpt-4o", 1000)
    releaseSessionDeployment("s1")
    expect(getSessionDeployment("s1", 1001)).toBeUndefined()
  })

  it("unknown sessions and blank ids are no-ops", () => {
    expect(getSessionDeployment("ghost", 1)).toBeUndefined()
    pinSessionDeployment("", "openai::gpt-4o", 1)
    pinSessionDeployment("s1", "", 1)
    expect(getSessionDeployment("", 2)).toBeUndefined()
    expect(getSessionDeployment("s1", 2)).toBeUndefined()
    releaseSessionDeployment("never-pinned") // no throw
  })

  it("pins are isolated per session", () => {
    pinSessionDeployment("s1", "a::m", 1)
    pinSessionDeployment("s2", "b::m", 1)
    releaseSessionDeployment("s1")
    expect(getSessionDeployment("s2", 2)).toBe("b::m")
  })
})
