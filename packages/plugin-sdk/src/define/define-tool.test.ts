import { defineTool } from "./define-tool"

describe("defineTool", () => {
  it("returns the tool contribution unchanged", () => {
    const def = {
      name: "summarize",
      description: "Summarize input text.",
      category: "Writing",
      parametersSchema: {
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      },
      requiresApproval: false,
    }

    expect(defineTool(def)).toBe(def)
  })
})
