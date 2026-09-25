import manifestJson from "../plugin.json"
import definition, { manifest } from "./index"
import { createWorkbook } from "./model"
import { OFFICE_TOOL_NAMES } from "./tools"
import { exportWorkbookXlsx } from "./xlsx"

const LOCALES = manifestJson.i18n.locales as Record<string, Record<string, string>>

interface ImporterLike {
  name: string
  import: (source: {
    content: string | ArrayBuffer
    filename?: string
  }) => Promise<{ success: boolean; data?: unknown; error?: string }>
}

function makeCtx() {
  let locale = "en"
  const localeHandlers: Array<() => void> = []
  const disposers: Array<() => void | Promise<void>> = []
  const toolDispose = jest.fn()
  const importerDispose = jest.fn()
  const rendererDispose = jest.fn()
  const registerTool = jest.fn((_tool: { name: string }) => toolDispose)
  const registerRenderer = jest.fn((_kind: string, _renderer: { name: string }) => rendererDispose)
  const registerImporter = jest.fn((_registration: ImporterLike) => importerDispose)
  const ctx = {
    pluginId: "cognia-office",
    artifact: { registerRenderer },
    agent: { registerTool },
    import: { registerImporter },
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
  expect(manifest.id).toBe("cognia-office")
  expect(Object.keys(LOCALES["zh-CN"]).sort()).toEqual(Object.keys(LOCALES.en).sort())
  expect(manifest.runtimeCompatibility?.mobile?.reason).toContain("Documents/cognia/exports")
})

it("registers the workbook renderer, XLSX importer, and all Office tools", async () => {
  const env = makeCtx()
  await definition.activate?.(env.ctx as never)
  expect(env.registerRenderer).toHaveBeenCalledWith(
    "cognia-office/workbook",
    expect.objectContaining({ mount: expect.any(Function), name: "Cognia Office Workbook" })
  )
  expect(env.registerImporter).toHaveBeenCalledWith(
    expect.objectContaining({ id: "xlsx", extensions: ["xlsx"], name: "Excel workbook" })
  )
  const importer = env.registerImporter.mock.calls[0][0]
  await expect(importer.import({ content: "not binary" })).resolves.toEqual({
    success: false,
    error: "XLSX import requires binary content.",
  })
  const bytes = await exportWorkbookXlsx(createWorkbook("Imported"))
  const content = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(content).set(bytes)
  await expect(importer.import({ content, filename: "imported.xlsx" })).resolves.toMatchObject({
    success: true,
    data: expect.objectContaining({
      title: "imported",
      sourceFilename: "imported.xlsx",
    }),
  })
  await expect(
    importer.import({
      content: Uint8Array.from([0x50, 0x4b, 0x03, 0x04]).buffer,
      filename: "broken.xlsx",
    })
  ).resolves.toMatchObject({ success: false, error: expect.any(String) })
  expect(new Set(env.registerTool.mock.calls.map(([tool]) => tool.name))).toEqual(
    new Set(OFFICE_TOOL_NAMES)
  )
})

it("re-registers the importer with localized labels on a locale change", async () => {
  const env = makeCtx()
  await definition.activate?.(env.ctx as never)
  env.switchLocale("zh-CN")
  expect(env.importerDispose).toHaveBeenCalledTimes(1)
  const importer = env.registerImporter.mock.calls[1][0]
  expect(importer.name).toBe("Excel 工作簿")
  await expect(importer.import({ content: "text" })).resolves.toEqual({
    success: false,
    error: "XLSX 导入需要二进制内容。",
  })
})

it("releases every registration through the lifecycle ledger", async () => {
  const env = makeCtx()
  await definition.activate?.(env.ctx as never)
  await env.dispose()
  expect(env.rendererDispose).toHaveBeenCalled()
  expect(env.importerDispose).toHaveBeenCalled()
  expect(env.toolDispose).toHaveBeenCalledTimes(OFFICE_TOOL_NAMES.length)
})
