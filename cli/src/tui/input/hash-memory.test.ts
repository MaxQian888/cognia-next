import { parseHashMemory } from "./hash-memory"

describe("parseHashMemory", () => {
  it("captures a `# fact` line, trimmed", () => {
    expect(parseHashMemory("# use pnpm not npm")).toBe("use pnpm not npm")
    expect(parseHashMemory("#\tuse tabs")).toBe("use tabs")
    expect(parseHashMemory("#   spaced   ")).toBe("spaced")
  })

  it("captures a multi-line fact", () => {
    expect(parseHashMemory("# line one\nline two")).toBe("line one\nline two")
  })

  it("does not hijack a heading with no space (sent to the model)", () => {
    expect(parseHashMemory("#heading")).toBeNull()
    expect(parseHashMemory("## section")).toBeNull()
  })

  it("returns null for a bare hash or empty fact", () => {
    expect(parseHashMemory("#")).toBeNull()
    expect(parseHashMemory("#   ")).toBeNull()
  })

  it("returns null for ordinary text and slash/bang lines", () => {
    expect(parseHashMemory("hello")).toBeNull()
    expect(parseHashMemory("/help")).toBeNull()
    expect(parseHashMemory("!ls")).toBeNull()
    expect(parseHashMemory("a # b")).toBeNull()
  })
})
