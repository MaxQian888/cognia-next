import { createPdfTools, PDF_TOOL_NAMES } from "./tools"

it("exposes the complete PDF tool contract with closed schemas", () => {
  const tools = createPdfTools({ pluginId: "cognia-pdf" } as never)
  expect(tools.map((tool) => tool.name)).toEqual(PDF_TOOL_NAMES)
  for (const tool of tools)
    expect(tool.definition.parametersSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
    })
})
