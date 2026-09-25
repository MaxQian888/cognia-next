import { createPresentationTools, PRESENTATION_TOOL_NAMES } from "./tools"

const tools = createPresentationTools({ pluginId: "cognia-presentations" } as never)

it("exposes closed schemas for the complete Presentations tool contract", () => {
  expect(tools.map((tool) => tool.name)).toEqual(PRESENTATION_TOOL_NAMES)
  tools.forEach((tool) =>
    expect(tool.definition.parametersSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
    })
  )
})

it("does not self-assign pluginId — the host owns tool attribution", () => {
  for (const tool of tools) expect(Object.hasOwn(tool, "pluginId")).toBe(false)
})

it("closes the slide element schema", () => {
  const create = tools.find((tool) => tool.name === "presentations_create")!
  const operations = (
    create.definition.parametersSchema as {
      properties: { operations: { items: { properties: { elements: { items: object } } } } }
    }
  ).properties.operations.items.properties.elements.items
  expect(operations).toMatchObject({
    additionalProperties: false,
    required: expect.arrayContaining(["id", "type"]),
  })
})

it("marks read-only tools retryable and file-bound tools with timeouts", () => {
  const byName = new Map(tools.map((tool) => [tool.name, tool.definition]))
  expect(byName.get("presentations_inspect")).toMatchObject({ retryable: true })
  expect(byName.get("presentations_validate")).toMatchObject({ retryable: true })
  expect(byName.get("presentations_preview")).toMatchObject({ retryable: true })
  expect(byName.get("presentations_import_pptx")).toMatchObject({ timeoutMs: 120_000 })
  expect(byName.get("presentations_export_pptx")).toMatchObject({ timeoutMs: 120_000 })
  expect(byName.get("presentations_validate")).toMatchObject({ timeoutMs: 60_000 })
})
