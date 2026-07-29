import { retiredNodeKind, retiredNodeKinds } from "./retired-kinds"

describe("retiredNodeKind", () => {
  it("reports a retired kind with the version that removed it", () => {
    expect(retiredNodeKind("action.github.runIssueLoop")).toEqual({ removedIn: "0.2.0" })
  })

  it("returns undefined for a kind that still ships", () => {
    expect(retiredNodeKind("action.http.request")).toBeUndefined()
  })

  it("returns undefined for an unrecognised kind rather than throwing", () => {
    expect(retiredNodeKind("action.someones.plugin.node")).toBeUndefined()
  })

  it("does not resolve inherited Object properties as retired kinds", () => {
    // `RETIRED` is a plain object literal, so a bare `RETIRED[kind]` lookup
    // would answer truthy for "constructor" / "toString" and mark an
    // arbitrary node retired.
    expect(retiredNodeKind("constructor")).toBeUndefined()
    expect(retiredNodeKind("toString")).toBeUndefined()
    expect(retiredNodeKind("__proto__")).toBeUndefined()
  })

  it("lists every github-delivery kind that was removed", () => {
    const kinds = retiredNodeKinds()
    expect(kinds).toHaveLength(14)
    expect(kinds.filter((k) => k.startsWith("action.github."))).toHaveLength(13)
    expect(kinds).toContain("trigger.github.webhook")
  })

  it("exposes a frozen record so a caller cannot register a retirement at runtime", () => {
    const before = retiredNodeKinds().length
    expect(() => {
      ;(retiredNodeKind("action.github.openPr") as { removedIn: string }).removedIn = "9.9.9"
    }).toThrow()
    expect(retiredNodeKinds()).toHaveLength(before)
    expect(retiredNodeKind("action.github.openPr")?.removedIn).toBe("0.2.0")
  })
})
