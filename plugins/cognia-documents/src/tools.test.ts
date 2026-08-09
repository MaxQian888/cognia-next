import { createDocumentTools, DOCUMENT_TOOL_NAMES } from "./tools"

it("exposes closed schemas for the complete Documents tool contract", () => {
  const tools = createDocumentTools({ pluginId: "cognia-documents" } as never)
  expect(tools.map((tool) => tool.name)).toEqual(DOCUMENT_TOOL_NAMES)
  tools.forEach((tool) =>
    expect(tool.definition.parametersSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
    })
  )
})
