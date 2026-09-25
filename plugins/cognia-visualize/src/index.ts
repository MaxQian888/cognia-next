import {
  defineExporter,
  definePlugin,
  definePluginManifest,
  type PluginContext,
} from "@cognia/plugin-sdk"
import manifestJson from "../plugin.json"
import { exportVisualizationReport } from "./export"
import { parseVisualization, VISUALIZATION_ARTIFACT_KIND, type VisualizationSpec } from "./model"
import { createVisualizationRenderer } from "./preview"
import { createVisualizeRuntime, VISUALIZATION_REPORT_FORMAT } from "./runtime"
import { createVisualizeTools } from "./tools"

// plugin.json is the manifest source of truth — including the `i18n.locales`
// bundle the manager registers before activate() runs.
export const manifest = definePluginManifest(manifestJson)

/**
 * The `visualization-report` exporter renders every visualization artifact in
 * the exported session into one standalone HTML document. The host resolves a
 * custom exporter only for the plugin that registered it, so it is reached
 * through `visualize_export_report` (→ `ctx.export.exportSession`). Specs are
 * collected through the caller-scoped artifact API (gated by `artifact:read`).
 */
function buildExporter(ctx: PluginContext, runtime: ReturnType<typeof createVisualizeRuntime>) {
  return defineExporter({
    id: VISUALIZATION_REPORT_FORMAT,
    name: ctx.i18n.t("exporter.name"),
    description: ctx.i18n.t("exporter.description"),
    format: VISUALIZATION_REPORT_FORMAT,
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
        title: data.session?.title ?? ctx.i18n.t("report.title"),
        lang: ctx.i18n.getCurrentLocale() === "zh-CN" ? "zh-CN" : "en",
        labels: runtime.exportLabels(),
      })
    },
  })
}

export default definePlugin({
  manifest,
  activate: async (ctx) => {
    const runtime = createVisualizeRuntime(ctx)
    ctx.lifecycle.onDispose(
      ctx.artifact.registerRenderer(
        VISUALIZATION_ARTIFACT_KIND,
        createVisualizationRenderer({
          t: (key, params) => ctx.i18n.t(key, params),
          onLocaleChange: (handler) => ctx.i18n.onLocaleChange(handler),
        })
      ),
      "cognia-visualize:renderer"
    )

    // Exporter labels are resolved at registration time, so re-register when
    // the locale changes (same pattern as cognia-documents).
    let disposeExporter = ctx.export.registerExporter(buildExporter(ctx, runtime))
    ctx.lifecycle.onDispose(
      ctx.i18n.onLocaleChange(() => {
        disposeExporter()
        disposeExporter = ctx.export.registerExporter(buildExporter(ctx, runtime))
      }),
      "cognia-visualize:locale"
    )
    ctx.lifecycle.onDispose(() => disposeExporter(), "cognia-visualize:exporter")

    for (const tool of createVisualizeTools(ctx))
      ctx.lifecycle.onDispose(ctx.agent.registerTool(tool), `cognia-visualize:tool:${tool.name}`)
    ctx.logger.info("cognia-visualize plugin activated")
  },
})
