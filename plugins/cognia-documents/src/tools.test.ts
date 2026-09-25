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

interface OpSchema {
  properties: { op: { const: string } }
  required: string[]
}

it("uses discriminated per-operation schemas with required fields", () => {
  const tools = createDocumentTools({ pluginId: "cognia-documents" } as never)
  const apply = tools.find((tool) => tool.name === "documents_apply_operations")!
  const items = (
    apply.definition.parametersSchema as {
      properties: { operations: { items: { oneOf: OpSchema[] } } }
    }
  ).properties.operations.items
  expect(items.oneOf.length).toBeGreaterThanOrEqual(16)
  const ops = items.oneOf.map((schema) => schema.properties.op.const)
  for (const op of [
    "setTitle",
    "appendParagraph",
    "appendHeading",
    "appendListItem",
    "appendTable",
    "insertBlock",
    "deleteBlock",
    "moveBlock",
    "replaceText",
    "updateTableCell",
    "addComment",
    "resolveComment",
    "reopenComment",
    "acceptChange",
    "rejectChange",
    "acceptAllChanges",
    "rejectAllChanges",
    "stripComments",
  ])
    expect(ops).toContain(op)
  const heading = items.oneOf.find((schema) => schema.properties.op.const === "appendHeading")
  expect(heading?.required).toEqual(["op", "text", "level"])
  const move = items.oneOf.find((schema) => schema.properties.op.const === "moveBlock")
  expect(move?.required).toEqual(["op", "blockId", "toIndex"])
})

it("surfaces runtime errors from tool execution", async () => {
  const tools = createDocumentTools({
    pluginId: "cognia-documents",
    artifact: { getArtifact: () => null },
  } as never)
  const inspectTool = tools.find((tool) => tool.name === "documents_inspect")!
  await expect(
    inspectTool.execute({ artifactId: "missing" }, { config: {} } as never)
  ).rejects.toThrow("Document artifact not found")
})

it("returns an actionable error for transcript export outside a session", async () => {
  const exportSession = jest.fn()
  const tools = createDocumentTools({
    pluginId: "cognia-documents",
    export: { exportSession },
  } as never)
  const exportTool = tools.find((tool) => tool.name === "documents_export_transcript")!
  await expect(exportTool.execute({}, { config: {} } as never)).resolves.toMatchObject({
    ok: false,
    error: expect.stringContaining("pass sessionId"),
  })
  expect(exportSession).not.toHaveBeenCalled()
})

it("gives file-dialog tools a budget beyond the 30s default and no path access class", () => {
  const tools = createDocumentTools({ pluginId: "cognia-documents" } as never)
  const timeouts = Object.fromEntries(tools.map((tool) => [tool.name, tool.definition.timeoutMs]))
  expect(timeouts).toMatchObject({
    documents_import_docx: 120_000,
    documents_export_docx: 120_000,
    documents_export_transcript: 120_000,
  })
  // No Documents tool takes a filesystem path, so none declares an access class.
  tools.forEach((tool) => {
    expect(tool.definition.access).toBeUndefined()
    expect(tool).not.toHaveProperty("pluginId")
  })
})

it("uses the calling session for transcript export when sessionId is omitted", async () => {
  const exportSession = jest.fn(async () => ({ success: false, error: "no session" }))
  const tools = createDocumentTools({
    pluginId: "cognia-documents",
    export: { exportSession },
  } as never)
  const exportTool = tools.find((tool) => tool.name === "documents_export_transcript")!
  await expect(
    exportTool.execute({}, { config: {}, sessionId: "s-ctx" } as never)
  ).resolves.toMatchObject({ ok: false, error: "no session" })
  expect(exportSession).toHaveBeenCalledWith("s-ctx", { format: "docx" })
})
