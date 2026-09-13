import definition, { manifest } from "./index"
import { VISUALIZE_TOOL_NAMES } from "./tools"

function createCtx() {
  const disposers = { renderer: jest.fn(), exporter: jest.fn(), locale: jest.fn() }
  const ctx = {
    pluginId: "cognia-visualize",
    artifact: {
      registerRenderer: jest.fn(() => disposers.renderer),
      listArtifacts: jest.fn(() => []),
    },
    agent: { registerTool: jest.fn(() => jest.fn()) },
    export: { registerExporter: jest.fn(() => disposers.exporter) },
    i18n: {
      registerTranslations: jest.fn(),
      t: (key: string) => key,
      getCurrentLocale: () => "en",
      onLocaleChange: jest.fn(() => disposers.locale),
    },
    logger: { info: jest.fn() },
  }
  return { ctx, disposers }
}

it("registers Visualize entirely through the plugin contract", async () => {
  const { ctx } = createCtx()
  await definition.activate?.(ctx as never)
  expect(manifest.id).toBe("cognia-visualize")
  expect(ctx.artifact.registerRenderer).toHaveBeenCalledWith(
    "cognia-visualize/visualization",
    expect.any(Object)
  )
  expect(ctx.export.registerExporter).toHaveBeenCalledWith(
    expect.objectContaining({ format: "visualization-report", extension: "html" })
  )
  expect(ctx.agent.registerTool.mock.calls.map(([tool]) => tool.name)).toEqual(VISUALIZE_TOOL_NAMES)
})

it("re-registers the exporter on locale change and disposes everything on deactivate", async () => {
  const { ctx, disposers } = createCtx()
  await definition.activate?.(ctx as never)
  const onLocale = ctx.i18n.onLocaleChange.mock.calls[0][0] as () => void
  onLocale()
  expect(disposers.exporter).toHaveBeenCalledTimes(1)
  expect(ctx.export.registerExporter).toHaveBeenCalledTimes(2)
  await definition.deactivate?.(ctx as never)
  expect(disposers.renderer).toHaveBeenCalled()
  expect(disposers.exporter).toHaveBeenCalledTimes(2)
  expect(disposers.locale).toHaveBeenCalled()
})
