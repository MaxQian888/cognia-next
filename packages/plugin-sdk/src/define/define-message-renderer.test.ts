import { defineMessageRenderer } from "./define-message-renderer"

describe("defineMessageRenderer", () => {
  it("returns the message renderer definition unchanged", () => {
    const def = {
      partType: "x-demo-result",
      label: "Demo Result",
      entry: "src/renderers/demo-result.tsx",
      export: "DemoResultRenderer",
    }

    expect(defineMessageRenderer(def)).toBe(def)
  })
})
