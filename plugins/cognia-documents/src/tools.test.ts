import { DOCUMENT_OPERATION_NAMES } from "./model"
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
  // One schema per model operation, no more and no fewer.
  expect([...ops].sort()).toEqual([...DOCUMENT_OPERATION_NAMES].sort())
})

it("accepts Markdown on create and reads documents back as Markdown", async () => {
  const artifacts = new Map<string, unknown>()
  const ctx = {
    pluginId: "cognia-documents",
    artifact: {
      createArtifact: jest.fn(async (input: { title: string; content: string }) => {
        artifacts.set("d1", {
          id: "d1",
          title: input.title,
          content: input.content,
          version: 1,
          metadata: {
            plugin: {
              kind: "cognia-documents/document",
              schemaVersion: 1,
              ownerPluginId: "cognia-documents",
            },
          },
        })
        return "d1"
      }),
      getArtifact: (id: string) => artifacts.get(id) ?? null,
      openArtifact: jest.fn(),
    },
    i18n: { t: (key: string) => key },
  }
  const tools = createDocumentTools(ctx as never)
  const create = tools.find((tool) => tool.name === "documents_create")!
  await expect(
    create.execute({ title: "Plan", markdown: "# Goals\n\n1. Ship" }, { config: {} } as never)
  ).resolves.toMatchObject({ ok: true, summary: { blockCount: 2 } })
  const read = tools.find((tool) => tool.name === "documents_read_markdown")!
  await expect(
    read.execute({ artifactId: "d1", blockIds: true }, { config: {} } as never)
  ).resolves.toMatchObject({
    markdown: "<!-- block:b1 -->\n# Goals\n\n<!-- block:b2 -->\n1. Ship",
  })
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
