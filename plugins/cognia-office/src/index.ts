import type { PluginDefinition, PluginManifest } from "@cognia/plugin-sdk"
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
      "office.preview.corner": "Row numbers",
      "office.preview.filtered": "Filtered",
      "office.preview.frozen": "Frozen",
      "office.preview.truncatedRows": "Showing first {count} of {total} rows",
      "office.preview.truncatedColumns": "Showing first {count} of {total} columns",
    })
    ctx.i18n.registerTranslations("zh-CN", {
      "office.preview.sheets": "工作表",
      "office.preview.validation": "校验",
      "office.preview.empty": "此工作表为空。",
      "office.preview.corner": "行号",
      "office.preview.filtered": "已筛选",
      "office.preview.frozen": "已冻结",
      "office.preview.truncatedRows": "仅显示前 {count}/{total} 行",
      "office.preview.truncatedColumns": "仅显示前 {count}/{total} 列",
    })
    // Resolve labels lazily through ctx.i18n.t so locale changes after
    // activation are reflected without re-mounting the renderer.
    ctx.artifact.registerRenderer(
      WORKBOOK_ARTIFACT_KIND,
      createWorkbookRenderer((key, params) => ctx.i18n.t(key, params))
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
