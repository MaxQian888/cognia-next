import { safeFilename } from "./safe-filename"

describe("safeFilename", () => {
  it("keeps non-ASCII names and strips only reserved characters", () => {
    expect(safeFilename("设计 / 方案: v2?", "x")).toBe("设计 _ 方案_ v2_")
    expect(safeFilename("a\u0000b\n c", "x")).toBe("a_b_ c")
  })

  it("falls back for an empty name and caps a long one", () => {
    expect(safeFilename("   ", "fallback")).toBe("fallback")
    expect(safeFilename("x".repeat(300), "f")).toHaveLength(180)
  })

  it("drops bidi controls and zero-width spaces, and keeps joiners", () => {
    expect(safeFilename("invoice\u202Etxt.exe", "x")).toBe("invoicetxt.exe")
    expect(safeFilename("\u200B\u2066", "fallback")).toBe("fallback")
    expect(safeFilename("👨\u200D👩", "x")).toBe("👨\u200D👩")
  })

  it("prefixes a stem Windows reserves for a device", () => {
    expect(safeFilename("CON", "x")).toBe("_CON")
    expect(safeFilename("nul.mp4", "x")).toBe("_nul.mp4")
    expect(safeFilename("com1", "x")).toBe("_com1")
    expect(safeFilename("console", "x")).toBe("console")
  })
})
