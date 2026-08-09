import type { PluginDefinition, PluginManifest } from "@/types/plugin"
import manifestJson from "../plugin.json"
import { WORKBOOK_ARTIFACT_KIND } from "./model"
import { createWorkbookRenderer } from "./preview"
import { createOfficeTools } from "./tools"
import type { OfficePluginContext } from "./runtime"
import { importWorkbookXlsx, XLSX_MIME } from "./xlsx"

export const manifest: PluginManifest = manifestJson as PluginManifest

const definition: PluginDefinition = {
  manifest,
  activate: async (ctx) => {
    ctx.i18n.registerTranslations("en", {
      "office.preview.sheets": "Workbook sheets",
      "office.preview.validation": "Validation",
      "office.preview.empty": "This sheet is empty.",
    })
    ctx.i18n.registerTranslations("zh-CN", {
      "office.preview.sheets": "工作表",
      "office.preview.validation": "校验",
      "office.preview.empty": "此工作表为空。",
    })
    ctx.artifact.registerRenderer(
      WORKBOOK_ARTIFACT_KIND,
      createWorkbookRenderer({
        sheets: ctx.i18n.t("office.preview.sheets"),
        validation: ctx.i18n.t("office.preview.validation"),
        empty: ctx.i18n.t("office.preview.empty"),
      })
    )
    ctx.import.registerImporter({
      id: "xlsx",
      name: "Excel workbook",
      description: "Import an XLSX workbook into the Cognia Office workbook model.",
      format: "xlsx",
      extensions: ["xlsx"],
      mimeType: XLSX_MIME,
      import: async (source) => {
        if (typeof source.content === "string") {
          return { success: false, error: "XLSX import requires binary content." }
        }
        try {
          const workbook = await importWorkbookXlsx(
            new Uint8Array(source.content),
            "",
            source.filename ?? "workbook.xlsx"
          )
          return { success: true, data: workbook }
        } catch (error) {
          return {
            success: false,
            error: error instanceof Error ? error.message : "XLSX import failed.",
          }
        }
      },
    })
    for (const tool of createOfficeTools(ctx as unknown as OfficePluginContext)) {
      ctx.agent.registerTool(tool)
    }
    ctx.logger.info("cognia-office plugin activated")
  },
}

export default definition
