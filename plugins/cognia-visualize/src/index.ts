import type { PluginDefinition, PluginManifest } from "@cognia/plugin-sdk"
import manifestJson from "../plugin.json"
import { VISUALIZATION_ARTIFACT_KIND } from "./model"
import { createVisualizationRenderer } from "./preview"
import type { VisualizePluginContext } from "./runtime"
import { createVisualizeTools } from "./tools"

export const manifest = manifestJson as PluginManifest
const definition: PluginDefinition = {
  manifest,
  activate: async (ctx) => {
    ctx.i18n.registerTranslations("en", {
      "visualize.preview.data": "Data",
      "visualize.preview.validation": "Validation",
    })
    ctx.i18n.registerTranslations("zh-CN", {
      "visualize.preview.data": "数据",
      "visualize.preview.validation": "校验",
    })
    ctx.artifact.registerRenderer(
      VISUALIZATION_ARTIFACT_KIND,
      createVisualizationRenderer({
        data: ctx.i18n.t("visualize.preview.data"),
        validation: ctx.i18n.t("visualize.preview.validation"),
      })
    )
    for (const tool of createVisualizeTools(ctx as unknown as VisualizePluginContext))
      ctx.agent.registerTool(tool)
    ctx.logger.info("cognia-visualize plugin activated")
  },
}
export default definition
