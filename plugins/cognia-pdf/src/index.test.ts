jest.mock("./pdf-engine", () => ({
  inspectPdf: jest.fn(async () => ({ pageCount: 1, fields: [], warnings: [] })),
  fillPdfFields: jest.fn(),
  extractPdfPages: jest.fn(),
  pdfFieldValueMatches: jest.fn(),
}))

import definition, { manifest } from "./index"
import { PDF_TOOL_NAMES } from "./tools"

function context() {
  const registerTool = jest.fn()
  const registerRenderer = jest.fn()
  const registerImporter = jest.fn()
  const createArtifact = jest.fn(async () => "pdf-1")
  const ctx = {
    pluginId: "cognia-pdf",
    artifact: {
      registerRenderer,
      createArtifact,
      openArtifact: jest.fn(),
      getArtifact: jest.fn(() => null),
    },
    import: { registerImporter },
    agent: { registerTool },
    i18n: { registerTranslations: jest.fn(), t: (key: string) => key },
    logger: { info: jest.fn() },
  }
  return { ctx, registerTool, registerRenderer, registerImporter, createArtifact }
}

it("registers the PDF renderer, importer, translations, and tools", async () => {
  const { ctx, registerTool, registerRenderer, registerImporter } = context()
  await definition.activate?.(ctx as never)
  expect(manifest.id).toBe("cognia-pdf")
  expect(registerRenderer).toHaveBeenCalledWith("cognia-pdf/document", expect.any(Object))
  expect(registerImporter).toHaveBeenCalledWith(
    expect.objectContaining({ id: "pdf", name: "pdf.importer.name" })
  )
  expect(registerTool.mock.calls.map(([tool]) => tool.name)).toEqual(PDF_TOOL_NAMES)
})

it("importer turns binary content into a PDF artifact", async () => {
  const { ctx, registerImporter, createArtifact } = context()
  await definition.activate?.(ctx as never)
  const importer = registerImporter.mock.calls[0][0]

  const result = await importer.import({
    content: new Uint8Array([1, 2, 3]).buffer,
    filename: "form.pdf",
  })

  expect(result).toMatchObject({ success: true, data: { ok: true, artifactId: "pdf-1" } })
  expect(createArtifact).toHaveBeenCalledWith(
    expect.objectContaining({ kind: "cognia-pdf/document", title: "form" })
  )
})

it("importer surfaces inspection failures as import errors", async () => {
  const { ctx, registerImporter } = context()
  await definition.activate?.(ctx as never)
  const importer = registerImporter.mock.calls[0][0]
  const { inspectPdf } = jest.mocked(await import("./pdf-engine"))
  inspectPdf.mockRejectedValueOnce(new Error("corrupt xref"))

  await expect(
    importer.import({ content: new Uint8Array([1]).buffer, filename: "bad.pdf" })
  ).resolves.toMatchObject({ success: false, error: "corrupt xref" })
})

it("importer rejects textual content", async () => {
  const { ctx, registerImporter } = context()
  await definition.activate?.(ctx as never)
  const importer = registerImporter.mock.calls[0][0]

  await expect(importer.import({ content: "not a pdf" })).resolves.toMatchObject({
    success: false,
    error: expect.stringContaining("binary"),
  })
})
