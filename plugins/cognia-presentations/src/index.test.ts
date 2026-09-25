jest.mock("./pptx", () => ({ importPptx: jest.fn(async () => ({ title: "Imported" })) }))
import definition, { manifest } from "./index"
import { I18N_MESSAGES } from "./i18n"
import { PRESENTATION_TOOL_NAMES } from "./tools"

function createCtx() {
  const registeredTools: unknown[] = []
  const toolResultRenderers: string[] = []
  const disposers: Array<() => void> = []
  const localeHandlers: Array<() => void> = []
  const toolDispose = jest.fn()
  const cardDispose = jest.fn()
  const ctx = {
    pluginId: "cognia-presentations",
    artifact: { registerRenderer: jest.fn(() => jest.fn()), openArtifact: jest.fn() },
    import: { registerImporter: jest.fn(() => jest.fn()) },
    agent: {
      registerTool: jest.fn((tool) => {
        registeredTools.push(tool)
        return toolDispose
      }),
    },
    toolResult: {
      registerToolResultRenderer: jest.fn((name: string, _component: unknown) => {
        toolResultRenderers.push(name)
        return cardDispose
      }),
    },
    i18n: {
      registerTranslations: jest.fn(),
      onLocaleChange: jest.fn((handler: () => void) => {
        localeHandlers.push(handler)
        return jest.fn()
      }),
      t: (key: string) => `t:${key}`,
    },
    lifecycle: { onDispose: jest.fn((dispose: () => void) => disposers.push(dispose)) },
    logger: { info: jest.fn() },
  }
  return {
    ctx,
    registeredTools,
    toolResultRenderers,
    disposers,
    localeHandlers,
    toolDispose,
    cardDispose,
  }
}

it("registers the complete Presentations plugin surface", async () => {
  const { ctx, registeredTools, toolResultRenderers, localeHandlers } = createCtx()
  await definition.activate?.(ctx as never)

  expect(manifest.id).toBe("cognia-presentations")
  expect(ctx.artifact.registerRenderer).toHaveBeenCalledWith(
    "cognia-presentations/deck",
    expect.objectContaining({ name: "t:renderer.name" })
  )
  expect(ctx.import.registerImporter).toHaveBeenCalledWith(
    expect.objectContaining({
      id: "pptx",
      format: "pptx",
      extensions: ["pptx"],
      name: "t:importer.name",
    })
  )
  expect(registeredTools.map((tool) => (tool as { name: string }).name)).toEqual(
    PRESENTATION_TOOL_NAMES
  )
  for (const tool of registeredTools) expect(Object.hasOwn(tool as object, "pluginId")).toBe(false)
  expect(toolResultRenderers).toEqual([...PRESENTATION_TOOL_NAMES])
  // One shared card component, bound to this activation's openArtifact.
  const cards = new Set(ctx.toolResult.registerToolResultRenderer.mock.calls.map((call) => call[1]))
  expect(cards.size).toBe(1)
  expect(localeHandlers).toHaveLength(1)
})

it("hands every registration to the lifecycle ledger", async () => {
  const { ctx, disposers, toolDispose, cardDispose } = createCtx()
  await definition.activate?.(ctx as never)
  // renderer + locale subscription + importer + every tool + every result card
  expect(disposers).toHaveLength(3 + PRESENTATION_TOOL_NAMES.length * 2)
  for (const dispose of disposers) dispose()
  expect(toolDispose).toHaveBeenCalledTimes(PRESENTATION_TOOL_NAMES.length)
  expect(cardDispose).toHaveBeenCalledTimes(PRESENTATION_TOOL_NAMES.length)
})

it("re-registers the importer when the locale changes", async () => {
  const { ctx, localeHandlers } = createCtx()
  await definition.activate?.(ctx as never)
  expect(ctx.import.registerImporter).toHaveBeenCalledTimes(1)
  localeHandlers[0]()
  expect(ctx.import.registerImporter).toHaveBeenCalledTimes(2)
})

it("declares the i18n bundle on the manifest instead of imperative registration", async () => {
  const { ctx } = createCtx()
  await definition.activate?.(ctx as never)
  expect(ctx.i18n.registerTranslations).not.toHaveBeenCalled()
  expect(manifest.i18n?.locales?.en?.["preview.slides"]).toBe("Slides")
  expect(I18N_MESSAGES["zh-CN"]["preview.slides"]).toBe("幻灯片")
  expect(manifest.runtimeCompatibility?.mobile?.reason).toContain("Documents/cognia/exports")
})
