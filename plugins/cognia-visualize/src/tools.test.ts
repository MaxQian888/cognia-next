import { createVisualizeTools, VISUALIZE_TOOL_NAMES } from "./tools"

it("exposes closed schemas for the complete Visualize tool contract", () => {
  const tools = createVisualizeTools({ pluginId: "cognia-visualize" } as never)
  expect(tools.map((tool) => tool.name)).toEqual(VISUALIZE_TOOL_NAMES)
  tools.forEach((tool) =>
    expect(tool.definition.parametersSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
    })
  )
})
