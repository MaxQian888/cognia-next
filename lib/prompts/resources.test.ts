import { parseResourceKey, resourceKey } from "./resources"

describe("resource keys", () => {
  it("round-trips a source and an id", () => {
    expect(resourceKey("preset", "p1")).toBe("preset:p1")
    expect(parseResourceKey("preset:p1")).toEqual({ source: "preset", id: "p1" })
  })

  it("keeps colons inside the id", () => {
    expect(parseResourceKey("instruction-file:%2Frepo|C:AGENTS.md")).toEqual({
      source: "instruction-file",
      id: "%2Frepo|C:AGENTS.md",
    })
  })

  it("reads a bare source as one without an id", () => {
    expect(parseResourceKey("code")).toEqual({ source: "code", id: "" })
  })
})
