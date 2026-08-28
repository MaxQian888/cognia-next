import type { Artifact } from "@cognia/plugin-sdk"
import type { PluginArtifactAPI } from "@cognia/plugin-sdk"
jest.mock("./pdf-engine", () => ({
  inspectPdf: jest.fn(),
  fillPdfFields: jest.fn(),
  extractPdfPages: jest.fn(),
}))

import * as pdfEngine from "./pdf-engine"
import { PDF_ARTIFACT_KIND } from "./model"
import { createPdfRuntime, type PdfPluginContext } from "./runtime"

const inspectPdf = jest.mocked(pdfEngine.inspectPdf)
const fillPdfFields = jest.mocked(pdfEngine.fillPdfFields)
const extractPdfPages = jest.mocked(pdfEngine.extractPdfPages)

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
  } as unknown as PdfPluginContext
  return { artifacts, ctx, save, updateArtifact }
}

beforeEach(() => {
  inspectPdf.mockReset().mockResolvedValue({
    pageCount: 1,
    encrypted: false,
    signed: false,
    fields: [
      {
        name: "name",
        kind: "text",
        value: "Before",
        readOnly: false,
        required: false,
        pageNumbers: [1],
        widgetIds: ["w1"],
      },
    ],
    metadata: {},
    warnings: [],
  })
  fillPdfFields.mockReset().mockResolvedValue({
    bytes: Uint8Array.from([4, 5, 6]),
    verifiedValues: { name: "After" },
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
  inspectPdf.mockResolvedValue({
    pageCount: 1,
    encrypted: false,
    signed: false,
    fields: [
      {
        name: "name",
        kind: "text",
        value: "After",
        readOnly: false,
        required: false,
        pageNumbers: [1],
        widgetIds: ["w1"],
      },
    ],
    metadata: {},
    warnings: [],
  })
  await expect(runtime.validate("pdf-1")).resolves.toMatchObject({ ok: true, findings: [] })
  expect(runtime.preview("pdf-1")).toEqual({ ok: true, artifactId: "pdf-1" })
  await expect(runtime.exportPdf("pdf-1", "filled.pdf")).resolves.toMatchObject({ ok: true })
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ suggestedName: "filled.pdf" }))
})

it("combines authorized PDF attachments into a new artifact", async () => {
  const { ctx } = context()
  const runtime = createPdfRuntime(ctx)
  await expect(
    runtime.extract({ handles: ["h1"], includePages: [[1]], title: "Selection" })
  ).resolves.toMatchObject({ ok: true, artifactId: "pdf-1" })
  expect(extractPdfPages).toHaveBeenCalledWith([
    { bytes: Uint8Array.from([1, 2, 3]), includePages: [1] },
  ])
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
