jest.mock("./docx", () => ({
  importDocx: jest.fn(async () => ({ title: "Imported" })),
  exportTranscriptDocx: jest.fn(async () => new Blob()),
}))

import type { CustomExporter, CustomImporter } from "@cognia/plugin-sdk"
import manifestJson from "../plugin.json"
import { importDocx } from "./docx"
import definition, { manifest } from "./index"
import { DOCUMENT_TOOL_NAMES } from "./tools"

const LOCALES = manifestJson.i18n.locales as Record<string, Record<string, string>>

function makeCtx() {
  const toolDispose = jest.fn()
  const registerTool = jest.fn((_tool: { name: string }) => toolDispose)
  const rendererDispose = jest.fn()
  const registerRenderer = jest.fn((_kind: string, _renderer: { name: string }) => rendererDispose)
  const importerDispose = jest.fn()
  const registerImporter = jest.fn((_registration: CustomImporter) => importerDispose)
  const exporterDispose = jest.fn()
  const registerExporter = jest.fn((_exporter: CustomExporter) => exporterDispose)
  const disposers: Array<() => void | Promise<void>> = []
  let locale = "en"
  const localeHandlers: Array<() => void> = []
  const ctx = {
    pluginId: "cognia-documents",
    artifact: { registerRenderer },
    import: { registerImporter },
    export: { registerExporter },
    agent: { registerTool },
    lifecycle: {
      signal: new AbortController().signal,
      onDispose: (dispose: () => void) => disposers.push(dispose),
    },
    i18n: {
      t: (key: string) => LOCALES[locale]?.[key] ?? LOCALES.en[key] ?? key,
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
    toolDispose,
    async dispose() {
      for (const dispose of disposers.reverse()) await dispose()
    },
    switchLocale(next: string) {
      locale = next
      localeHandlers.forEach((handler) => handler())
    },
  }
}

it("declares its manifest from plugin.json, including the i18n bundle", () => {
  expect(manifest.id).toBe("cognia-documents")
  expect(manifest.i18n?.locales?.en?.["renderer.name"]).toBe("Cognia Document")
  const en = Object.keys(LOCALES.en).sort()
  expect(Object.keys(LOCALES["zh-CN"]).sort()).toEqual(en)
})

it("registers the complete Documents plugin surface", async () => {
  const env = makeCtx()
  await definition.activate?.(env.ctx)
  expect(env.registerRenderer).toHaveBeenCalledWith("cognia-documents/document", expect.any(Object))
  expect(env.registerRenderer.mock.calls[0][1].name).toBe("Cognia Document")
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

it("returns localized importer errors and passes localized labels to the parser", async () => {
  const env = makeCtx()
  await definition.activate?.(env.ctx)
  env.switchLocale("zh-CN")
  const importer = env.registerImporter.mock.calls[1][0]
  await expect(importer.import({ content: "text" })).resolves.toEqual({
    success: false,
    error: "DOCX 导入需要二进制内容。",
  })
  await importer.import({ content: new ArrayBuffer(2), filename: "a.docx" })
  expect(importDocx).toHaveBeenLastCalledWith(expect.any(Uint8Array), "a.docx", {
    emptyComment: "（空批注）",
    unknownAuthor: "未知",
    untitled: "文档",
  })
})

it("releases every registration through the lifecycle ledger", async () => {
  const env = makeCtx()
  await definition.activate?.(env.ctx)
  await env.dispose()
  expect(env.rendererDispose).toHaveBeenCalled()
  expect(env.importerDispose).toHaveBeenCalled()
  expect(env.exporterDispose).toHaveBeenCalled()
  expect(env.toolDispose).toHaveBeenCalledTimes(DOCUMENT_TOOL_NAMES.length)
})
