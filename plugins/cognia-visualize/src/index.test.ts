import type { CustomExporter, ExportData, PluginToolRegistration } from "@cognia/plugin-sdk"
import manifestJson from "../plugin.json"
import definition, { manifest } from "./index"
import { createVisualization, VISUALIZATION_ARTIFACT_KIND } from "./model"
import { VISUALIZE_TOOL_NAMES } from "./tools"

const LOCALES = manifestJson.i18n.locales as Record<string, Record<string, string>>

function createCtx() {
  const disposers: Array<() => void> = []
  const rendererDispose = jest.fn()
  const exporterDispose = jest.fn()
  const toolDispose = jest.fn()
  const localeDispose = jest.fn()
  const ctx = {
    pluginId: "cognia-visualize",
    artifact: {
      registerRenderer: jest.fn((_kind: string, _renderer: { name: string }) => rendererDispose),
      listArtifacts: jest.fn(() => [
        {
          id: "v1",
          title: "Revenue",
          content: JSON.stringify(
            createVisualization({
              title: "Revenue",
              profile: "bar",
              data: [{ label: "Q1", value: 3 }],
            })
          ),
          metadata: { plugin: { kind: VISUALIZATION_ARTIFACT_KIND } },
        },
        { id: "x", title: "Other", content: "{}", metadata: { plugin: { kind: "other/kind" } } },
      ]),
    },
    agent: { registerTool: jest.fn((_tool: PluginToolRegistration) => toolDispose) },
    export: { registerExporter: jest.fn((_exporter: CustomExporter) => exporterDispose) },
    lifecycle: {
      signal: new AbortController().signal,
      onDispose: (dispose: () => void) => disposers.push(dispose),
    },
    i18n: {
      t: (key: string) => LOCALES.en[key] ?? key,
      getCurrentLocale: () => "en",
      onLocaleChange: jest.fn((_listener: () => void) => localeDispose),
    },
    logger: { info: jest.fn() },
  }
  return { ctx, disposers, rendererDispose, exporterDispose, toolDispose, localeDispose }
}

it("declares its manifest, bundle, and the export permission the report tool needs", () => {
  expect(manifest.id).toBe("cognia-visualize")
  expect(manifest.permissions).toContain("export:session")
  expect(Object.keys(LOCALES["zh-CN"]).sort()).toEqual(Object.keys(LOCALES.en).sort())
  expect(manifest.runtimeCompatibility?.mobile?.reason).toContain("Documents/cognia/exports")
})

it("registers Visualize entirely through the plugin contract", async () => {
  const { ctx } = createCtx()
  await definition.activate?.(ctx as never)
  expect(ctx.artifact.registerRenderer).toHaveBeenCalledWith(
    "cognia-visualize/visualization",
    expect.any(Object)
  )
  expect(ctx.artifact.registerRenderer.mock.calls[0][1].name).toBe("Cognia Visualization")
  expect(ctx.export.registerExporter).toHaveBeenCalledWith(
    expect.objectContaining({ format: "visualization-report", extension: "html" })
  )
  expect(ctx.agent.registerTool.mock.calls.map(([tool]) => tool.name)).toEqual(VISUALIZE_TOOL_NAMES)
})

it("the report exporter renders this session's visualizations only", async () => {
  const { ctx } = createCtx()
  await definition.activate?.(ctx as never)
  const exporter = ctx.export.registerExporter.mock.calls[0][0]
  const html = await exporter.export({
    session: { id: "s1", title: "Planning" },
    exportedAt: new Date(),
  } as unknown as ExportData)
  expect(ctx.artifact.listArtifacts).toHaveBeenCalledWith({ sessionId: "s1" })
  expect(String(html)).toContain("Planning")
  expect(String(html)).toContain("Revenue")
  expect(String(html)).not.toContain("Other")
})

it("re-registers the exporter on locale change and disposes everything via the lifecycle", async () => {
  const { ctx, disposers, rendererDispose, exporterDispose, toolDispose, localeDispose } =
    createCtx()
  await definition.activate?.(ctx as never)
  const onLocale = ctx.i18n.onLocaleChange.mock.calls[0][0] as () => void
  onLocale()
  expect(exporterDispose).toHaveBeenCalledTimes(1)
  expect(ctx.export.registerExporter).toHaveBeenCalledTimes(2)
  for (const dispose of disposers.reverse()) dispose()
  expect(rendererDispose).toHaveBeenCalled()
  expect(exporterDispose).toHaveBeenCalledTimes(2)
  expect(localeDispose).toHaveBeenCalled()
  expect(toolDispose).toHaveBeenCalledTimes(VISUALIZE_TOOL_NAMES.length)
})
