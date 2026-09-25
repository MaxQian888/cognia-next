jest.mock("./pdf-engine", () => ({
  inspectPdf: jest.fn(async () => ({
    pageCount: 1,
    encrypted: false,
    signed: false,
    fields: [],
    metadata: {},
    warnings: [],
  })),
  fillPdfFields: jest.fn(async () => ({
    bytes: Uint8Array.from([4]),
    verifiedValues: { name: "After" },
    inspection: { pageCount: 1, fields: [], warnings: [] },
  })),
  extractPdfPages: jest.fn(async () => Uint8Array.from([7])),
  pdfFieldValueMatches: jest.fn(() => true),
}))

import { createPdfTools, PDF_TOOL_NAMES } from "./tools"
import type { PdfPluginContext } from "./runtime"

function stubContext(overrides: Partial<PdfPluginContext> = {}): PdfPluginContext {
  return {
    i18n: { t: (key: string) => key },
    artifact: {
      createArtifact: jest.fn(async () => "pdf-1"),
      openArtifact: jest.fn(),
      getArtifact: jest.fn(() => null),
      updateArtifact: jest.fn(),
    },
    files: {
      open: jest.fn(async () => []),
      readAttachment: jest.fn(async () => ({
        id: "f1",
        name: "in.pdf",
        mimeType: "application/pdf",
        size: 3,
        bytes: Uint8Array.from([1, 2, 3]),
      })),
      save: jest.fn(async () => ({ saved: true })),
    },
    ocr: {
      extract: jest.fn(async () => ({
        providerId: "tesseract-wasm",
        cached: false,
        combinedText: "text",
        combinedMarkdown: "# text",
        pages: [],
      })),
    },
    ...overrides,
  } as unknown as PdfPluginContext
}

const TOOL_CTX = { sessionId: "s1", messageId: "m1" }

it("exposes the complete PDF tool contract with closed schemas", () => {
  const tools = createPdfTools(stubContext())
  expect(tools.map((tool) => tool.name)).toEqual(PDF_TOOL_NAMES)
  for (const tool of tools)
    expect(tool.definition.parametersSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
    })
})

it("gives dialog, processing, and OCR tools budgets beyond the 30s default", () => {
  const tools = createPdfTools(stubContext())
  const timeouts = Object.fromEntries(tools.map((tool) => [tool.name, tool.definition.timeoutMs]))
  expect(timeouts).toMatchObject({
    pdf_import: 120_000,
    pdf_fill_form: 120_000,
    pdf_extract_pages: 120_000,
    pdf_extract_text: 300_000,
    pdf_validate: 120_000,
    pdf_export: 120_000,
  })
  expect(tools.every((tool) => !("pluginId" in tool))).toBe(true)
})

it("describes form values with anyOf instead of a type array carrying items", () => {
  const fill = createPdfTools(stubContext()).find((tool) => tool.name === "pdf_fill_form")!
  const values = (
    fill.definition.parametersSchema as {
      properties: { values: { additionalProperties: Record<string, unknown> } }
    }
  ).properties.values.additionalProperties
  expect(values).not.toHaveProperty("type")
  expect(values).not.toHaveProperty("items")
  expect(values).toEqual({
    anyOf: [{ type: "string" }, { type: "boolean" }, { type: "array", items: { type: "string" } }],
  })
})

it("routes pdf_extract_text through the OCR surface with page range and format", async () => {
  const ctx = stubContext()
  const tools = createPdfTools(ctx)
  const extractText = tools.find((tool) => tool.name === "pdf_extract_text")!

  const result = await extractText.execute(
    { handle: "h1", pageRange: "1-3,5", format: "text", languages: ["en"] },
    TOOL_CTX as never
  )

  expect(result).toMatchObject({ ok: true, text: "text" })
  expect(ctx.ocr.extract).toHaveBeenCalledWith(
    expect.objectContaining({ pageRange: "1-3,5", format: "text", languages: ["en"] })
  )
})

it("forwards per-source passwords and page selections to pdf_extract_pages", async () => {
  const extractPdfPages = jest.mocked((await import("./pdf-engine")).extractPdfPages)
  const ctx = stubContext()
  const tools = createPdfTools(ctx)
  const extract = tools.find((tool) => tool.name === "pdf_extract_pages")!

  await extract.execute(
    { sources: [{ handle: "h1", includePages: [1, 2], password: "pw" }], title: "Sel" },
    TOOL_CTX as never
  )

  expect(extractPdfPages).toHaveBeenCalledWith([
    { bytes: Uint8Array.from([1, 2, 3]), includePages: [1, 2], password: "pw" },
  ])
})

it("passes the optional password through validate and export", async () => {
  const ctx = stubContext()
  const tools = createPdfTools(ctx)
  const validate = tools.find((tool) => tool.name === "pdf_validate")!
  const exportTool = tools.find((tool) => tool.name === "pdf_export")!

  await expect(
    validate.execute({ artifactId: "missing", password: "pw" }, TOOL_CTX as never)
  ).rejects.toThrow("not found")
  await expect(
    exportTool.execute(
      { artifactId: "missing", suggestedName: "x", password: "pw" },
      TOOL_CTX as never
    )
  ).rejects.toThrow("not found")
})
