jest.mock("./pdf-engine", () => ({
  inspectPdf: jest.fn(async () => ({ pageCount: 1, fields: [], warnings: [] })),
  fillPdfFields: jest.fn(),
  extractPdfPages: jest.fn(),
  pdfFieldValueMatches: jest.fn(),
  openPdfForRender: jest.fn(),
  isRenderCancelled: jest.fn(() => false),
}))

import manifestJson from "../plugin.json"
import definition, { manifest } from "./index"
import { PDF_TOOL_NAMES } from "./tools"

const LOCALES = manifestJson.i18n.locales as Record<string, Record<string, string>>

interface ImporterLike {
  name: string
  import: (source: { content: string | ArrayBuffer; filename?: string }) => Promise<unknown>
}

function context() {
  let locale = "en"
  const localeHandlers: Array<() => void> = []
  const disposers: Array<() => void | Promise<void>> = []
  const toolDispose = jest.fn()
  const importerDispose = jest.fn()
  const rendererDispose = jest.fn()
  const registerTool = jest.fn((_tool: { name: string }) => toolDispose)
  const registerRenderer = jest.fn((_kind: string, _renderer: { name: string }) => rendererDispose)
  const registerImporter = jest.fn((_importer: ImporterLike) => importerDispose)
  const createArtifact = jest.fn(
    async (_input: { title: string; kind: string; metadata?: Record<string, unknown> }) => "pdf-1"
  )
  const save = jest.fn(async () => ({ saved: true }))
  const ctx = {
    pluginId: "cognia-pdf",
    artifact: {
      registerRenderer,
      createArtifact,
      openArtifact: jest.fn(),
      getArtifact: jest.fn(() => null),
    },
    files: { save },
    import: { registerImporter },
    agent: { registerTool },
    lifecycle: {
      signal: new AbortController().signal,
      onDispose: (dispose: () => void) => disposers.push(dispose),
    },
    i18n: {
      t: (key: string) => LOCALES[locale]?.[key] ?? LOCALES.en[key] ?? key,
      onLocaleChange: (handler: () => void) => {
        localeHandlers.push(handler)
        return jest.fn()
      },
    },
    logger: { info: jest.fn() },
  }
  return {
    ctx,
    registerTool,
    registerRenderer,
    registerImporter,
    createArtifact,
    toolDispose,
    importerDispose,
    rendererDispose,
    switchLocale(next: string) {
      locale = next
      localeHandlers.forEach((handler) => handler())
    },
    async dispose() {
      for (const dispose of disposers.reverse()) await dispose()
    },
  }
}

it("declares its manifest and a complete en/zh-CN bundle from plugin.json", () => {
  expect(manifest.id).toBe("cognia-pdf")
  expect(Object.keys(LOCALES["zh-CN"]).sort()).toEqual(Object.keys(LOCALES.en).sort())
  expect(manifest.runtimeCompatibility?.mobile?.reason).toContain("Documents/cognia/exports")
})

it("registers the PDF renderer, importer, and tools", async () => {
  const env = context()
  await definition.activate?.(env.ctx as never)
  expect(env.registerRenderer).toHaveBeenCalledWith("cognia-pdf/document", expect.any(Object))
  expect(env.registerRenderer.mock.calls[0][1].name).toBe("Cognia PDF")
  expect(env.registerImporter).toHaveBeenCalledWith(
    expect.objectContaining({ id: "pdf", name: "PDF document" })
  )
  expect(env.registerTool.mock.calls.map(([tool]) => tool.name)).toEqual(PDF_TOOL_NAMES)
})

it("importer turns binary content into a user-initiated PDF artifact", async () => {
  const env = context()
  await definition.activate?.(env.ctx as never)
  const importer = env.registerImporter.mock.calls[0][0]

  const result = await importer.import({
    content: new Uint8Array([1, 2, 3]).buffer,
    filename: "form.pdf",
  })

  expect(result).toMatchObject({ success: true, data: { ok: true, artifactId: "pdf-1" } })
  expect(env.createArtifact).toHaveBeenCalledWith(
    expect.objectContaining({ kind: "cognia-pdf/document", title: "form" })
  )
  expect(env.createArtifact.mock.calls[0][0].metadata).toMatchObject({ userInitiated: true })
})

it("importer surfaces inspection failures as import errors", async () => {
  const env = context()
  await definition.activate?.(env.ctx as never)
  const importer = env.registerImporter.mock.calls[0][0]
  const { inspectPdf } = jest.mocked(await import("./pdf-engine"))
  inspectPdf.mockRejectedValueOnce(new Error("corrupt xref"))

  await expect(
    importer.import({ content: new Uint8Array([1]).buffer, filename: "bad.pdf" })
  ).resolves.toMatchObject({ success: false, error: "corrupt xref" })
})

it("re-registers a localized importer on a locale change", async () => {
  const env = context()
  await definition.activate?.(env.ctx as never)
  env.switchLocale("zh-CN")
  expect(env.importerDispose).toHaveBeenCalledTimes(1)
  const importer = env.registerImporter.mock.calls[1][0]
  expect(importer.name).toBe("PDF 文档")
  await expect(importer.import({ content: "not a pdf" })).resolves.toEqual({
    success: false,
    error: "PDF 导入需要二进制内容。",
  })
})

it("releases every registration through the lifecycle ledger", async () => {
  const env = context()
  await definition.activate?.(env.ctx as never)
  await env.dispose()
  expect(env.rendererDispose).toHaveBeenCalled()
  expect(env.importerDispose).toHaveBeenCalled()
  expect(env.toolDispose).toHaveBeenCalledTimes(PDF_TOOL_NAMES.length)
})
