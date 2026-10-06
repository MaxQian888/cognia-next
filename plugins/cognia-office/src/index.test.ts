import manifestJson from "../plugin.json"

const mockRendererDeps: Array<{
  exportWorkbook?: (artifactId: string, allowLoss: boolean) => Promise<unknown>
}> = []
jest.mock("./preview", () => {
  const actual = jest.requireActual("./preview")
  return {
    ...actual,
    createWorkbookRenderer: (deps: (typeof mockRendererDeps)[number]) => {
      mockRendererDeps.push(deps)
      return actual.createWorkbookRenderer(deps)
    },
  }
})

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
  const cardDispose = jest.fn()
  const registerToolResultRenderer = jest.fn((_name: string, _component: unknown) => cardDispose)
  const ctx = {
    pluginId: "cognia-office",
    artifact: { registerRenderer, openArtifact: jest.fn() },
    agent: { registerTool },
    import: { registerImporter },
    toolResult: { registerToolResultRenderer },
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
    registerToolResultRenderer,
    cardDispose,
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
  expect(manifest.nodeRuntime).toEqual({ directory: "runtime", entry: "probe.mjs" })
  expect(manifest.optionalPermissions).toEqual(
    expect.arrayContaining(["shell:execute", "network:fetch"])
  )
  expect(manifest.permissions).not.toContain("shell:execute")
  expect(manifest.runtimeCompatibility?.headless?.availability).toBe("degraded")
})

it("registers the optional engine tool without inspecting, installing, or loading packages", async () => {
  const env = makeCtx()
  const nodeRuntime = {
    status: jest.fn(),
    prepare: jest.fn(),
    probe: jest.fn(),
    cancel: jest.fn(),
    remove: jest.fn(),
  }
  Object.assign(env.ctx, { nodeRuntime })
  await definition.activate?.(env.ctx as never)
  expect(env.registerTool.mock.calls.map(([tool]) => tool.name)).toContain("office_engine_runtime")
  for (const method of Object.values(nodeRuntime)) expect(method).not.toHaveBeenCalled()
  await env.dispose()
  for (const method of Object.values(nodeRuntime)) expect(method).not.toHaveBeenCalled()
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
  // Every office tool result renders through the workbook card.
  expect(env.registerToolResultRenderer.mock.calls.map(([name]) => name)).toEqual([
    ...OFFICE_TOOL_NAMES,
  ])
  const component = env.registerToolResultRenderer.mock.calls[0][1]
  expect(env.registerToolResultRenderer.mock.calls.every(([, card]) => card === component)).toBe(
    true
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
  expect(env.cardDispose).toHaveBeenCalledTimes(OFFICE_TOOL_NAMES.length)
})

it("wires the preview's Export button to the validated XLSX export", async () => {
  const env = makeCtx()
  const workbook = createWorkbook("Legacy")
  workbook.unsupportedFeatures = ["Macros are present."]
  const save = jest.fn(async () => ({ saved: true, platform: "web" as const }))
  Object.assign(env.ctx, {
    artifact: {
      ...env.ctx.artifact,
      getArtifact: () => ({
        id: "w1",
        title: "Legacy",
        content: JSON.stringify(workbook),
        version: 1,
        metadata: {
          plugin: {
            kind: "cognia-office/workbook",
            schemaVersion: 1,
            ownerPluginId: "cognia-office",
          },
        },
      }),
    },
    files: { save },
  })
  mockRendererDeps.length = 0
  await definition.activate?.(env.ctx as never)
  const exportWorkbook = mockRendererDeps[0].exportWorkbook!
  await expect(exportWorkbook("w1", false)).resolves.toMatchObject({ requiresConfirmation: true })
  expect(save).not.toHaveBeenCalled()
  await expect(exportWorkbook("w1", true)).resolves.toMatchObject({
    ok: true,
    filename: "Legacy.xlsx",
  })
  expect(save).toHaveBeenCalledTimes(1)
})
