import type { Artifact } from "@cognia/plugin-sdk"
import type { PluginArtifactAPI } from "@cognia/plugin-sdk"
jest.mock("./pdf-engine", () => ({
  inspectPdf: jest.fn(),
  fillPdfFields: jest.fn(),
  extractPdfPages: jest.fn(),
  pdfFieldValueMatches: jest.fn(),
}))

import * as pdfEngine from "./pdf-engine"
import { PDF_ARTIFACT_KIND, PDF_MAX_BYTES } from "./model"
import { createPdfRuntime, type PdfPluginContext } from "./runtime"

const inspectPdf = jest.mocked(pdfEngine.inspectPdf)
const fillPdfFields = jest.mocked(pdfEngine.fillPdfFields)
const extractPdfPages = jest.mocked(pdfEngine.extractPdfPages)
const pdfFieldValueMatches = jest.mocked(pdfEngine.pdfFieldValueMatches)

const INSPECTION = {
  pageCount: 1,
  encrypted: false,
  signed: false,
  fields: [
    {
      name: "name",
      kind: "text" as const,
      value: "Before",
      readOnly: false,
      required: false,
      pageNumbers: [1],
      widgetIds: ["w1"],
    },
  ],
  metadata: {},
  warnings: [],
}

function context() {
  const artifacts = new Map<string, Artifact>()
  const createArtifact = jest.fn(
    async (input: Parameters<PluginArtifactAPI["createArtifact"]>[0]) => {
      const id = `pdf-${artifacts.size + 1}`
      artifacts.set(id, {
        id,
        sessionId: input.sessionId ?? "",
        messageId: input.messageId ?? "",
        type: "code",
        title: input.title,
        content: input.content,
        language: "json",
        version: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
        metadata: {
          ...input.metadata,
          plugin: {
            kind: input.kind!,
            schemaVersion: input.schemaVersion!,
            ownerPluginId: "cognia-pdf",
          },
        },
      })
      return id
    }
  )
  const updateArtifact = jest.fn(
    (id: string, update: Parameters<PluginArtifactAPI["updateArtifact"]>[1]) => {
      const current = artifacts.get(id)!
      const next = {
        ...current,
        content: update.content ?? current.content,
        version: current.version + 1,
      }
      artifacts.set(id, next)
      return next
    }
  )
  const file = {
    id: "file-1",
    name: "form.pdf",
    mimeType: "application/pdf",
    size: 3,
    bytes: Uint8Array.from([1, 2, 3]),
  }
  const save = jest.fn(async () => ({ saved: true }))
  const ocrExtract = jest.fn(async () => ({
    providerId: "tesseract-wasm",
    cached: false,
    combinedText: "page one text",
    combinedMarkdown: "# page one",
    pages: [{ pageNumber: 1, text: "page one text", fromTextLayer: true }],
  }))
  const ctx = {
    pluginId: "cognia-pdf",
    artifact: {
      createArtifact,
      updateArtifact,
      getArtifact: (id: string) => artifacts.get(id) ?? null,
      openArtifact: jest.fn(),
    },
    files: {
      open: jest.fn(async () => [file]),
      readAttachment: jest.fn(async () => file),
      save,
    },
    ocr: { extract: ocrExtract },
  } as unknown as PdfPluginContext
  return { artifacts, ctx, save, updateArtifact, ocrExtract, file }
}

beforeEach(() => {
  inspectPdf.mockReset().mockResolvedValue(INSPECTION)
  pdfFieldValueMatches.mockReset().mockReturnValue(true)
  fillPdfFields.mockReset().mockResolvedValue({
    bytes: Uint8Array.from([4, 5, 6]),
    verifiedValues: { name: "After" },
    inspection: { ...INSPECTION, fields: [{ ...INSPECTION.fields[0], value: "After" }] },
  })
  extractPdfPages.mockReset().mockResolvedValue(Uint8Array.from([7, 8, 9]))
})

it("imports, fills, validates, previews, and exports a PDF artifact", async () => {
  const { ctx, save, updateArtifact } = context()
  const runtime = createPdfRuntime(ctx)
  const imported = await runtime.importPdf({ sessionId: "s1" })

  expect(imported).toMatchObject({ ok: true, artifactId: "pdf-1" })
  expect(ctx.artifact.getArtifact("pdf-1")?.metadata?.plugin?.kind).toBe(PDF_ARTIFACT_KIND)
  expect(runtime.inspect("pdf-1")).toMatchObject({ pageCount: 1, fields: [{ name: "name" }] })

  await expect(
    runtime.fill({ artifactId: "pdf-1", expectedVersion: 1, values: { name: "After" } })
  ).resolves.toMatchObject({ ok: true, version: 2, verifiedValues: { name: "After" } })
  expect(updateArtifact).toHaveBeenCalledWith(
    "pdf-1",
    expect.objectContaining({ expectedVersion: 1 })
  )
  await expect(runtime.validate("pdf-1")).resolves.toMatchObject({ ok: true, findings: [] })
  expect(runtime.preview("pdf-1")).toEqual({ ok: true, artifactId: "pdf-1" })
  await expect(runtime.exportPdf("pdf-1", "filled.pdf")).resolves.toMatchObject({ ok: true })
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ suggestedName: "filled.pdf" }))
})

it("stores the engine's reopened inspection instead of re-inspecting after fill", async () => {
  const { ctx } = context()
  const runtime = createPdfRuntime(ctx)
  await runtime.importPdf({})
  inspectPdf.mockClear()

  await runtime.fill({ artifactId: "pdf-1", expectedVersion: 1, values: { name: "After" } })

  expect(inspectPdf).not.toHaveBeenCalled()
  expect(runtime.inspect("pdf-1")).toMatchObject({ fields: [{ value: "After" }] })
})

it("imports from an authorized attachment handle and enforces the size cap", async () => {
  const { ctx, file } = context()
  const runtime = createPdfRuntime(ctx)
  await expect(runtime.importPdf({ handle: "h1" })).resolves.toMatchObject({ ok: true })

  const huge = { ...file, bytes: new Uint8Array(PDF_MAX_BYTES + 1) }
  ctx.files.readAttachment = jest.fn(async () => huge)
  await expect(runtime.importPdf({ handle: "huge" })).rejects.toThrow("size limit")
})

it("returns cancelled when the file picker is dismissed", async () => {
  const { ctx } = context()
  ctx.files.open = jest.fn(async () => [])
  const runtime = createPdfRuntime(ctx)
  await expect(runtime.importPdf({})).resolves.toEqual({ ok: false, cancelled: true })
})

it("combines attachment and artifact sources into a new artifact", async () => {
  const { ctx } = context()
  const runtime = createPdfRuntime(ctx)
  await runtime.importPdf({})
  await expect(
    runtime.extract({
      sources: [{ handle: "h1", includePages: [1] }, { artifactId: "pdf-1" }],
      title: "Selection",
    })
  ).resolves.toMatchObject({ ok: true, artifactId: "pdf-2" })
  expect(extractPdfPages).toHaveBeenCalledWith([
    { bytes: Uint8Array.from([1, 2, 3]), includePages: [1] },
    { bytes: expect.any(Uint8Array) },
  ])
})

it("rejects sources that specify both handle and artifactId", async () => {
  const { ctx } = context()
  const runtime = createPdfRuntime(ctx)
  await expect(
    runtime.extract({ sources: [{ handle: "h1", artifactId: "pdf-1" }], title: "x" })
  ).rejects.toThrow("not both")
})

it("skips reopen validation for encrypted artifacts without a password", async () => {
  const { ctx, artifacts } = context()
  const runtime = createPdfRuntime(ctx)
  await runtime.importPdf({})
  const artifact = artifacts.get("pdf-1")!
  const document = JSON.parse(artifact.content)
  document.inspection.encrypted = true
  artifacts.set("pdf-1", { ...artifact, content: JSON.stringify(document) })
  inspectPdf.mockClear()

  await expect(runtime.validate("pdf-1")).resolves.toMatchObject({
    ok: true,
    skippedReopen: true,
    findings: [expect.objectContaining({ code: "pdf.encrypted" })],
  })
  expect(inspectPdf).not.toHaveBeenCalled()

  await runtime.validate("pdf-1", "pw")
  expect(inspectPdf).toHaveBeenCalledWith(expect.any(Uint8Array), "pw")
})

it("exports encrypted artifacts without a reopen check and sanitizes the filename", async () => {
  const { ctx, artifacts, save } = context()
  const runtime = createPdfRuntime(ctx)
  await runtime.importPdf({})
  const artifact = artifacts.get("pdf-1")!
  const document = JSON.parse(artifact.content)
  document.inspection.encrypted = true
  artifacts.set("pdf-1", { ...artifact, content: JSON.stringify(document) })
  inspectPdf.mockClear()

  await expect(runtime.exportPdf("pdf-1", "a/b")).resolves.toMatchObject({ ok: true })
  expect(inspectPdf).not.toHaveBeenCalled()
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ suggestedName: "a-b.pdf" }))
})

it("surfaces reopened-structure and expected-value findings from validate", async () => {
  const { ctx, artifacts } = context()
  const runtime = createPdfRuntime(ctx)
  await runtime.importPdf({})
  const artifact = artifacts.get("pdf-1")!
  const document = JSON.parse(artifact.content)
  document.expectedValues = { name: "Expected" }
  artifacts.set("pdf-1", { ...artifact, content: JSON.stringify(document) })

  inspectPdf.mockResolvedValue({
    ...INSPECTION,
    pageCount: 7,
    warnings: ["linearization lost"],
  })
  pdfFieldValueMatches.mockReturnValue(false)

  const result = await runtime.validate("pdf-1")
  expect(result.ok).toBe(false)
  expect(result.findings).toEqual([
    expect.objectContaining({ code: "pages.mismatch" }),
    expect.objectContaining({ code: "field.value_mismatch" }),
    expect.objectContaining({ severity: "warning", code: "pdf.warning" }),
  ])
})

it("refuses export when the reopened page count diverges", async () => {
  const { ctx, save } = context()
  const runtime = createPdfRuntime(ctx)
  await runtime.importPdf({})
  inspectPdf.mockResolvedValue({ ...INSPECTION, pageCount: 9 })

  await expect(runtime.exportPdf("pdf-1")).rejects.toThrow("validation failed")
  expect(save).not.toHaveBeenCalled()
})

it("requires a source for text extraction and defaults the imported title", async () => {
  const { ctx } = context()
  const runtime = createPdfRuntime(ctx)

  await expect(runtime.extractText({})).rejects.toThrow("handle or an artifactId")

  const imported = await runtime.importPdfBytes({ bytes: Uint8Array.from([1]) })
  expect(imported).toMatchObject({ ok: true })
  expect(runtime.inspect(imported.artifactId)).toMatchObject({ title: "PDF document" })
})

it("extracts text through the host OCR surface", async () => {
  const { ctx, ocrExtract } = context()
  const runtime = createPdfRuntime(ctx)
  await runtime.importPdf({})

  const result = await runtime.extractText({ artifactId: "pdf-1", pageRange: "1-2" })

  expect(result).toMatchObject({ ok: true, text: "page one text" })
  expect(ocrExtract).toHaveBeenCalledWith(
    expect.objectContaining({
      pageRange: "1-2",
      source: expect.objectContaining({ kind: "blob", mimeType: "application/pdf" }),
    })
  )
})

it("rejects missing and foreign artifacts", async () => {
  const { artifacts, ctx } = context()
  const runtime = createPdfRuntime(ctx)
  expect(() => runtime.inspect("missing")).toThrow("not found")
  artifacts.set("foreign", {
    id: "foreign",
    sessionId: "",
    messageId: "",
    type: "code",
    title: "foreign",
    content: "{}",
    version: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  })
  expect(() => runtime.inspect("foreign")).toThrow("not a Cognia PDF")
})
