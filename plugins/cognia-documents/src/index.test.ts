jest.mock("./docx", () => ({
  importDocx: jest.fn(async () => ({ title: "Imported" })),
  exportTranscriptDocx: jest.fn(async () => new Blob()),
}))

import type { CustomExporter, CustomImporter } from "@cognia/plugin-sdk"
import definition, { manifest } from "./index"
import { DOCUMENT_TOOL_NAMES } from "./tools"

function makeCtx() {
  const registerTool = jest.fn()
  const rendererDispose = jest.fn()
  const registerRenderer = jest.fn(() => rendererDispose)
  const importerDispose = jest.fn()
  const registerImporter = jest.fn((_registration: CustomImporter) => importerDispose)
  const exporterDispose = jest.fn()
  const registerExporter = jest.fn((_exporter: CustomExporter) => exporterDispose)
  const translations = new Map<string, Record<string, string>>()
  let locale = "en"
  const localeHandlers: Array<() => void> = []
  const ctx = {
    pluginId: "cognia-documents",
    artifact: { registerRenderer },
    import: { registerImporter },
    export: { registerExporter },
    agent: { registerTool },
    i18n: {
      registerTranslations: jest.fn((loc: string, values: Record<string, string>) => {
        translations.set(loc, values)
      }),
      t: (key: string) => translations.get(locale)?.[key] ?? key,
      onLocaleChange: jest.fn((handler: () => void) => {
        localeHandlers.push(handler)
        return jest.fn()
      }),
    },
    logger: { info: jest.fn() },
  } as never
  return {
    ctx,
    registerTool,
    registerRenderer,
    registerImporter,
    registerExporter,
    rendererDispose,
    importerDispose,
    exporterDispose,
    switchLocale(next: string) {
      locale = next
      localeHandlers.forEach((handler) => handler())
    },
  }
}

it("registers the complete Documents plugin surface", async () => {
  const env = makeCtx()
  await definition.activate?.(env.ctx)
  expect(manifest.id).toBe("cognia-documents")
  expect(env.registerRenderer).toHaveBeenCalledWith("cognia-documents/document", expect.any(Object))
  expect(env.registerImporter).toHaveBeenCalledWith(
    expect.objectContaining({ id: "docx", format: "docx", extensions: ["docx"] })
  )
  expect(env.registerExporter).toHaveBeenCalledWith(
    expect.objectContaining({ id: "docx", format: "docx", extension: "docx" })
  )
  expect(env.registerTool.mock.calls.map(([tool]) => tool.name)).toEqual(DOCUMENT_TOOL_NAMES)
})

it("localizes importer and exporter labels and re-registers on locale change", async () => {
  const env = makeCtx()
  await definition.activate?.(env.ctx)
  expect(env.registerImporter.mock.calls[0][0].name).toBe("Word document")
  env.switchLocale("zh-CN")
  expect(env.registerImporter).toHaveBeenCalledTimes(2)
  expect(env.registerImporter.mock.calls[1][0].name).toBe("Word 文档")
  expect(env.registerExporter.mock.calls[1][0].name).toBe("DOCX 会话记录")
})

it("runs all registration disposers on deactivate", async () => {
  const env = makeCtx()
  await definition.activate?.(env.ctx)
  definition.deactivate?.(env.ctx)
  expect(env.rendererDispose).toHaveBeenCalled()
  expect(env.importerDispose).toHaveBeenCalled()
  expect(env.exporterDispose).toHaveBeenCalled()
})
