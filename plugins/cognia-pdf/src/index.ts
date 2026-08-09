import type { PluginDefinition, PluginManifest } from "@/types/plugin"
import manifestJson from "../plugin.json"
import { PDF_ARTIFACT_KIND, PDF_MIME } from "./model"
import { createPdfRenderer } from "./preview"
import type { PdfPluginContext } from "./runtime"
import { createPdfTools } from "./tools"
import { inspectPdf } from "./pdf-engine"

export const manifest = manifestJson as PluginManifest

const definition: PluginDefinition = {
  manifest,
  activate: async (ctx) => {
    ctx.i18n.registerTranslations("en", {
      "pdf.preview.title": "PDF preview",
      "pdf.preview.unsupported": "Your environment cannot display this PDF preview.",
    })
    ctx.i18n.registerTranslations("zh-CN", {
      "pdf.preview.title": "PDF 预览",
      "pdf.preview.unsupported": "当前环境无法显示此 PDF 预览。",
    })
    ctx.artifact.registerRenderer(
      PDF_ARTIFACT_KIND,
      createPdfRenderer({
        title: ctx.i18n.t("pdf.preview.title"),
        unsupported: ctx.i18n.t("pdf.preview.unsupported"),
      })
    )
    ctx.import.registerImporter({
      id: "pdf",
      name: "PDF document",
      description: "Import a PDF into the Cognia PDF model.",
      format: "pdf",
      extensions: ["pdf"],
      mimeType: PDF_MIME,
      import: async (source) => {
        if (typeof source.content === "string")
          return { success: false, error: "PDF import requires binary content." }
        try {
          return { success: true, data: await inspectPdf(new Uint8Array(source.content)) }
        } catch (error) {
          return {
            success: false,
            error: error instanceof Error ? error.message : "PDF import failed.",
          }
        }
      },
    })
    for (const tool of createPdfTools(ctx as unknown as PdfPluginContext))
      ctx.agent.registerTool(tool)
    ctx.logger.info("cognia-pdf plugin activated")
  },
}

export default definition
