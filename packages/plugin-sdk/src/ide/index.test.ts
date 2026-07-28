import { defineIdeManifest } from "./index"

describe("defineIdeManifest", () => {
  it("preserves the stable author declaration by reference", () => {
    const ide = {
      schemaVersion: 1 as const,
      targets: ["monaco", "pro-ide"] as const,
      providers: [{ id: "hover", kind: "hover" as const, handler: "provideHover" }],
    }
    expect(defineIdeManifest(ide)).toBe(ide)
  })
})
