import type { PluginDefinition, PluginManifest } from "@cognia/plugin-sdk"
import manifestJson from "../plugin.json"
import { PDF_ARTIFACT_KIND, PDF_MIME } from "./model"
import { createPdfRenderer } from "./preview"
import { createPdfRuntime, type PdfPluginContext } from "./runtime"
import { createPdfTools } from "./tools"

export const manifest = manifestJson as PluginManifest

const definition: PluginDefinition = {
  manifest,
  activate: async (ctx) => {
    ctx.i18n.registerTranslations("en", {
      "pdf.preview.title": "PDF preview",
      "pdf.preview.unsupported": "Your environment cannot display this PDF preview.",
      "pdf.preview.error": "Unable to render this PDF artifact.",
      "pdf.preview.download": "Download PDF",
      "pdf.importer.name": "PDF document",
      "pdf.importer.description": "Import a PDF into the Cognia PDF model.",
    })
    ctx.i18n.registerTranslations("zh-CN", {
      "pdf.preview.title": "PDF 预览",
      "pdf.preview.unsupported": "当前环境无法显示此 PDF 预览。",
      "pdf.preview.error": "无法渲染此 PDF 文档。",
      "pdf.preview.download": "下载 PDF",
      "pdf.importer.name": "PDF 文档",
      "pdf.importer.description": "将 PDF 导入 Cognia PDF 模型。",
    })
    ctx.artifact.registerRenderer(
      PDF_ARTIFACT_KIND,
      createPdfRenderer({
        title: ctx.i18n.t("pdf.preview.title"),
        unsupported: ctx.i18n.t("pdf.preview.unsupported"),
        error: ctx.i18n.t("pdf.preview.error"),
        download: ctx.i18n.t("pdf.preview.download"),
      })
    )
    const pdfCtx = ctx as unknown as PdfPluginContext
    const runtime = createPdfRuntime(pdfCtx)
    ctx.import.registerImporter({
      id: "pdf",
      name: ctx.i18n.t("pdf.importer.name"),
      description: ctx.i18n.t("pdf.importer.description"),
      format: "pdf",
      extensions: ["pdf"],
      mimeType: PDF_MIME,
      import: async (source) => {
        if (typeof source.content === "string")
          return { success: false, error: "PDF import requires binary content." }
        try {
          // Import means "become a PDF artifact": the document model (bytes +
          // inspection) is what preview/fill/export all operate on.
          return {
            success: true,
            data: await runtime.importPdfBytes({
              bytes: new Uint8Array(source.content),
              filename: source.filename,
            }),
          }
        } catch (error) {
          return {
            success: false,
            error: error instanceof Error ? error.message : "PDF import failed.",
          }
        }
      },
    })
    for (const tool of createPdfTools(pdfCtx)) ctx.agent.registerTool(tool)
    ctx.logger.info("cognia-pdf plugin activated")
  },
}

export default definition
