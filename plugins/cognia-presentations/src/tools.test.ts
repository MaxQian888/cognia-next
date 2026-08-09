import { createPresentationTools, PRESENTATION_TOOL_NAMES } from "./tools"

it("exposes closed schemas for the complete Presentations tool contract", () => {
  const tools = createPresentationTools({ pluginId: "cognia-presentations" } as never)
  expect(tools.map((tool) => tool.name)).toEqual(PRESENTATION_TOOL_NAMES)
  tools.forEach((tool) =>
    expect(tool.definition.parametersSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
    })
  )
})
