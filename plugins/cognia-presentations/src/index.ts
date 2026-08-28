import type { PluginDefinition, PluginManifest } from "@cognia/plugin-sdk"
import manifestJson from "../plugin.json"
import { PRESENTATION_ARTIFACT_KIND, PPTX_MIME } from "./model"
import { importPptx } from "./pptx"
import { createPresentationRenderer } from "./preview"
import type { PresentationsPluginContext } from "./runtime"
import { createPresentationTools } from "./tools"

export const manifest = manifestJson as PluginManifest
const definition: PluginDefinition = {
  manifest,
  activate: async (ctx) => {
    ctx.i18n.registerTranslations("en", {
      "presentations.preview.slides": "Slides",
      "presentations.preview.notes": "Speaker notes",
      "presentations.preview.validation": "Validation",
    })
    ctx.i18n.registerTranslations("zh-CN", {
      "presentations.preview.slides": "幻灯片",
      "presentations.preview.notes": "演讲者备注",
      "presentations.preview.validation": "校验",
    })
    ctx.artifact.registerRenderer(
      PRESENTATION_ARTIFACT_KIND,
      createPresentationRenderer({
        slides: ctx.i18n.t("presentations.preview.slides"),
        notes: ctx.i18n.t("presentations.preview.notes"),
        validation: ctx.i18n.t("presentations.preview.validation"),
      })
    )
    ctx.import.registerImporter({
      id: "pptx",
      name: "PowerPoint presentation",
      description: "Import PPTX into the Cognia presentation model.",
      format: "pptx",
      extensions: ["pptx"],
      mimeType: PPTX_MIME,
      import: async (source) => {
        if (typeof source.content === "string")
          return { success: false, error: "PPTX import requires binary content." }
        try {
          return {
            success: true,
            data: await importPptx(new Uint8Array(source.content), source.filename),
          }
        } catch (error) {
          return {
            success: false,
            error: error instanceof Error ? error.message : "PPTX import failed.",
          }
        }
      },
    })
    for (const tool of createPresentationTools(ctx as unknown as PresentationsPluginContext))
      ctx.agent.registerTool(tool)
    ctx.logger.info("cognia-presentations plugin activated")
  },
}
export default definition
