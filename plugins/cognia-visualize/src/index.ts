import {
  defineExporter,
  type PluginContext,
  type PluginDefinition,
  type PluginManifest,
} from "@cognia/plugin-sdk"
import manifestJson from "../plugin.json"
import { exportVisualizationReport } from "./export"
import { parseVisualization, VISUALIZATION_ARTIFACT_KIND, type VisualizationSpec } from "./model"
import { createVisualizationRenderer } from "./preview"
import { createVisualizeTools } from "./tools"

export const manifest = manifestJson as PluginManifest

const EN: Record<string, string> = {
  "visualize.preview.data": "Data",
  "visualize.preview.validation": "Validation",
  "visualize.preview.meta": "{count} data points",
  "visualize.preview.parseError": "This artifact is not a valid Cognia visualization: {error}",
  "visualize.preview.col.label": "Label",
  "visualize.preview.col.value": "Value",
  "visualize.preview.col.group": "Group",
  "visualize.preview.col.source": "Source",
  "visualize.preview.col.target": "Target",
  "visualize.preview.col.start": "Start",
  "visualize.preview.col.end": "End",
  "visualize.preview.col.x": "X",
  "visualize.preview.col.y": "Y",
  "visualize.exporter.name": "Visualization report",
  "visualize.exporter.description":
    "Export every visualization in this session as one standalone HTML report.",
  "visualize.report.title": "Visualization report",
  "visualize.report.empty": "This session contains no Cognia visualizations.",
}

const ZH_CN: Record<string, string> = {
  "visualize.preview.data": "数据",
  "visualize.preview.validation": "校验",
  "visualize.preview.meta": "{count} 个数据点",
  "visualize.preview.parseError": "此 artifact 不是有效的 Cognia 可视化：{error}",
  "visualize.preview.col.label": "标签",
  "visualize.preview.col.value": "值",
  "visualize.preview.col.group": "分组",
  "visualize.preview.col.source": "来源",
  "visualize.preview.col.target": "目标",
  "visualize.preview.col.start": "开始",
  "visualize.preview.col.end": "结束",
  "visualize.preview.col.x": "X",
  "visualize.preview.col.y": "Y",
  "visualize.exporter.name": "可视化报告",
  "visualize.exporter.description": "将会话中的全部可视化导出为一份独立的 HTML 报告。",
  "visualize.report.title": "可视化报告",
  "visualize.report.empty": "此会话中没有 Cognia 可视化。",
}

/**
 * The `visualization-report` exporter renders every visualization artifact in
 * the exported session into one standalone HTML document. Specs are collected
 * through the caller-scoped artifact API (gated by `artifact:read`).
 */
function buildExporter(ctx: PluginContext) {
  return defineExporter({
    id: "visualization-report",
    name: ctx.i18n.t("visualize.exporter.name"),
    description: ctx.i18n.t("visualize.exporter.description"),
    format: "visualization-report",
    extension: "html",
    mimeType: "text/html",
    export: async (data) => {
      const artifacts = ctx.artifact.listArtifacts(
        data.session ? { sessionId: data.session.id } : undefined
      )
      const specs: VisualizationSpec[] = []
      for (const artifact of artifacts) {
        if (artifact.metadata?.plugin?.kind !== VISUALIZATION_ARTIFACT_KIND) continue
        try {
          specs.push(parseVisualization(artifact.content))
        } catch {
          // A corrupted artifact should not sink the whole report.
        }
      }
      return exportVisualizationReport(specs, {
        title: data.session?.title ?? ctx.i18n.t("visualize.report.title"),
        lang: ctx.i18n.getCurrentLocale() === "zh-CN" ? "zh-CN" : "en",
        labels: {
          columns: Object.fromEntries(
            ["label", "value", "group", "source", "target", "start", "end", "x", "y"].map((key) => [
              key,
              ctx.i18n.t(`visualize.preview.col.${key}`),
            ])
          ),
          dataHeading: ctx.i18n.t("visualize.preview.data"),
          emptyReport: ctx.i18n.t("visualize.report.empty"),
        },
      })
    },
  })
}

/** Disposers captured per activation context so `deactivate` can release them. */
const disposersByContext = new WeakMap<PluginContext, Array<() => void>>()

const definition: PluginDefinition = {
  manifest,
  activate: async (ctx) => {
    const disposers: Array<() => void> = []
    disposersByContext.set(ctx, disposers)
    ctx.i18n.registerTranslations("en", EN)
    ctx.i18n.registerTranslations("zh-CN", ZH_CN)

    disposers.push(
      ctx.artifact.registerRenderer(
        VISUALIZATION_ARTIFACT_KIND,
        createVisualizationRenderer({
          t: ctx.i18n.t,
          onLocaleChange: (handler) => ctx.i18n.onLocaleChange(handler),
        })
      )
    )

    // Exporter labels are resolved at registration time, so re-register when
    // the locale changes (same pattern as cognia-documents).
    let disposeExporter = ctx.export.registerExporter(buildExporter(ctx))
    disposers.push(() => disposeExporter())
    disposers.push(
      ctx.i18n.onLocaleChange(() => {
        disposeExporter()
        disposeExporter = ctx.export.registerExporter(buildExporter(ctx))
      })
    )

    for (const tool of createVisualizeTools(ctx)) disposers.push(ctx.agent.registerTool(tool))
    ctx.logger.info("cognia-visualize plugin activated")
  },
  deactivate: (ctx) => {
    for (const dispose of (ctx && disposersByContext.get(ctx)) ?? []) dispose()
    if (ctx) disposersByContext.delete(ctx)
    ctx?.logger.info("cognia-visualize plugin deactivated")
  },
}
export default definition
