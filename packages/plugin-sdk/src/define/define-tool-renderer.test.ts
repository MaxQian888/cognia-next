import { defineToolRenderer } from "./define-tool-renderer"

describe("defineToolRenderer", () => {
  it("returns the tool renderer definition unchanged", () => {
    const def = {
      toolName: "demo_lookup",
      label: "Demo Lookup",
      entry: "src/renderers/demo-lookup.tsx",
      export: "DemoLookupCard",
    }

    expect(defineToolRenderer(def)).toBe(def)
  })
})
