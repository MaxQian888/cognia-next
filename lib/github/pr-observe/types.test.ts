import { parseRepoFullName, unfetchedObservation } from "./types"

describe("parseRepoFullName", () => {
  it("splits owner/name", () => {
    expect(parseRepoFullName("acme/app")).toEqual({
      fullName: "acme/app",
      owner: "acme",
      name: "app",
    })
  })
  it("strips a trailing .git and trims whitespace", () => {
    expect(parseRepoFullName("  acme/app.git ")).toEqual({
      fullName: "acme/app",
      owner: "acme",
      name: "app",
    })
  })
  it.each(["", "noslash", "a/b/c", "/x", "x/", "/"])("throws on %p", (bad) => {
    expect(() => parseRepoFullName(bad)).toThrow(/invalid repo full name/)
  })
})

describe("unfetchedObservation", () => {
  it("returns a zeroed, not-fetched observation for the repo", () => {
    const obs = unfetchedObservation("acme/app", 1234)
    expect(obs.fetched).toBe(false)
    expect(obs.repo).toBe("acme/app")
    expect(obs.observedAt).toBe(1234)
    expect(obs.pr.number).toBe(0)
    expect(obs.ci.summary).toBe("unknown")
    expect(obs.review.decision).toBe("none")
    expect(obs.mergeability.state).toBe("unknown")
    expect(obs.changed).toEqual({ metadata: false, ci: false, review: false })
  })
})
