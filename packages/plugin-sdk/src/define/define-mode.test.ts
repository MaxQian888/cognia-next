import { defineMode } from "./define-mode"

describe("defineMode", () => {
  it("returns the mode contribution unchanged", () => {
    const def = {
      id: "plugin-review",
      name: "Plugin Review",
      description: "Review plugin code.",
      icon: "SearchCheck" as const,
      systemPrompt: "Review the plugin carefully.",
      outputFormat: "markdown" as const,
    }

    expect(defineMode(def)).toBe(def)
  })
})
