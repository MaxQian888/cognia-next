import * as ui from "./index"

describe("lib/ui barrel", () => {
  it("re-exports avatar helpers", () => {
    expect(typeof ui.avatarColor).toBe("function")
    expect(typeof ui.avatarGlyph).toBe("function")
    expect(typeof ui.deterministicColor).toBe("function")
    expect(typeof ui.initials).toBe("function")
  })

  it("re-exports captureScreenshot", () => {
    expect(typeof ui.captureScreenshot).toBe("function")
  })

  it("avatar helpers behave the same when imported via barrel", () => {
    expect(ui.initials("Alice Bob")).toBe("AB")
    expect(ui.deterministicColor("seed")).toMatch(/^oklch\(/)
    expect(ui.avatarGlyph({ name: "X" })).toBe("X")
    expect(ui.avatarColor({ name: "X", avatarColor: "red" })).toBe("red")
  })
})
