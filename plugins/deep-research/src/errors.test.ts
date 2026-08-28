import { ResearchToolError, classifyResearchError, isFatalResearchError } from "./errors"

describe("isFatalResearchError", () => {
  it("marks a precondition failure fatal so the run stops", () => {
    expect(isFatalResearchError(new ResearchToolError("NO_SEARCH_PROVIDER", "none"))).toBe(true)
  })

  it("leaves a per-page fault non-fatal so the loop keeps going", () => {
    // Losing one source is not losing the answer; aborting the run there would
    // throw away every other source already gathered.
    expect(isFatalResearchError(new ResearchToolError("FAILED", "404", false))).toBe(false)
  })

  it("treats an ordinary error as non-fatal", () => {
    expect(isFatalResearchError(new Error("socket hang up"))).toBe(false)
    expect(isFatalResearchError("nope")).toBe(false)
  })
})

describe("classifyResearchError", () => {
  it("passes our own code through", () => {
    expect(classifyResearchError(new ResearchToolError("WEB_DISABLED", "off"))).toBe("WEB_DISABLED")
  })

  it("reads the host's structured no-provider marker", () => {
    // `ctx.ai` throws a plain Error carrying `code: "NO_PROVIDER_AVAILABLE"`.
    // Reading the marker (not its prose) keeps the friendly card working
    // without importing anything host-private.
    const err = Object.assign(new Error("no provider"), { code: "NO_PROVIDER_AVAILABLE" })
    expect(classifyResearchError(err)).toBe("NO_PROVIDER")
  })

  it("recognizes the permission gate by error name", () => {
    const err = new Error("lacks ai:chat")
    err.name = "PermissionError"
    expect(classifyResearchError(err)).toBe("NO_AI_PERMISSION")
  })

  it("recognizes the PII gate by error name", () => {
    const err = new Error("blocked")
    err.name = "PluginPiiError"
    expect(classifyResearchError(err)).toBe("BLOCKED")
  })

  it("falls back to FAILED for anything else", () => {
    expect(classifyResearchError(new Error("socket hang up"))).toBe("FAILED")
    expect(classifyResearchError("string")).toBe("FAILED")
    expect(classifyResearchError(undefined)).toBe("FAILED")
  })
})
