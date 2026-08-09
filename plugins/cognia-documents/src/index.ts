import type { PluginDefinition, PluginManifest } from "@/types/plugin"
import manifestJson from "../plugin.json"
import { importDocx } from "./docx"
import { DOCUMENT_ARTIFACT_KIND, DOCX_MIME } from "./model"
import { createDocumentRenderer } from "./preview"
import type { DocumentsPluginContext } from "./runtime"
import { createDocumentTools } from "./tools"

export const manifest = manifestJson as PluginManifest
const definition: PluginDefinition = {
  manifest,
  activate: async (ctx) => {
    ctx.i18n.registerTranslations("en", {
      "documents.preview.comments": "Comments",
      "documents.preview.changes": "Tracked changes",
      "documents.preview.validation": "Validation",
    })
    ctx.i18n.registerTranslations("zh-CN", {
      "documents.preview.comments": "批注",
      "documents.preview.changes": "修订",
      "documents.preview.validation": "校验",
    })
    ctx.artifact.registerRenderer(
      DOCUMENT_ARTIFACT_KIND,
      createDocumentRenderer({
        comments: ctx.i18n.t("documents.preview.comments"),
        changes: ctx.i18n.t("documents.preview.changes"),
        validation: ctx.i18n.t("documents.preview.validation"),
      })
    )
    ctx.import.registerImporter({
      id: "docx",
      name: "Word document",
      description: "Import DOCX into the Cognia document model.",
      format: "docx",
      extensions: ["docx"],
      mimeType: DOCX_MIME,
      import: async (source) => {
        if (typeof source.content === "string")
          return { success: false, error: "DOCX import requires binary content." }
        try {
          return {
            success: true,
            data: await importDocx(new Uint8Array(source.content), source.filename),
          }
        } catch (error) {
          return {
            success: false,
            error: error instanceof Error ? error.message : "DOCX import failed.",
          }
        }
      },
    })
    for (const tool of createDocumentTools(ctx as unknown as DocumentsPluginContext))
      ctx.agent.registerTool(tool)
    ctx.logger.info("cognia-documents plugin activated")
  },
}
export default definition
