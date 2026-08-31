import { definePlugin } from "./define-plugin"

describe("definePlugin", () => {
  it("returns the same definition", () => {
    const definition = {
      manifest: {
        id: "example",
        name: "Example",
        version: "1.0.0",
        type: "frontend",
        main: "index.ts",
      },
    } as never

    expect(definePlugin(definition)).toBe(definition)
  })
})
