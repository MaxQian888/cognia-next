import {
  defineImporter,
  definePlugin,
  definePluginManifest,
  type PluginContext,
} from "@cognia/plugin-sdk"
import manifestJson from "../plugin.json"
import { WORKBOOK_ARTIFACT_KIND, type WorkbookDocument } from "./model"
import { createWorkbookRenderer } from "./preview"
import { createOfficeTools } from "./tools"
import { importWorkbookXlsx, XLSX_MIME } from "./xlsx"

// plugin.json is the manifest source of truth — including the `i18n.locales`
// bundle the manager registers before activate() runs.
export const manifest = definePluginManifest(manifestJson)

type Translate = PluginContext["i18n"]["t"]

function buildImporter(t: Translate) {
  return defineImporter<WorkbookDocument>({
    id: "xlsx",
    name: t("importer.name"),
    description: t("importer.description"),
    format: "xlsx",
    extensions: ["xlsx"],
    mimeType: XLSX_MIME,
    import: async (source) => {
      if (typeof source.content === "string") {
        return { success: false, error: t("importer.binaryRequired") }
      }
      try {
        const workbook = await importWorkbookXlsx(
          new Uint8Array(source.content),
          "",
          source.filename ?? undefined,
          t("import.untitled")
        )
        return { success: true, data: workbook }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : t("importer.failed"),
        }
      }
    },
  })
}

export default definePlugin({
  manifest,
  activate: async (ctx) => {
    const t: Translate = (key, params) => ctx.i18n.t(key, params)
    // Labels resolve through `t` at render time and the renderer re-renders on
    // a locale switch, so a mounted workbook restyles without a remount.
    ctx.lifecycle.onDispose(
      ctx.artifact.registerRenderer(
        WORKBOOK_ARTIFACT_KIND,
        createWorkbookRenderer({ t, onLocaleChange: (handler) => ctx.i18n.onLocaleChange(handler) })
      ),
      "cognia-office:renderer"
    )

    // Importer labels are resolved at registration time — re-register on a
    // locale change.
    let disposeImporter = ctx.import.registerImporter(buildImporter(t))
    ctx.lifecycle.onDispose(
      ctx.i18n.onLocaleChange(() => {
        disposeImporter()
        disposeImporter = ctx.import.registerImporter(buildImporter(t))
      }),
      "cognia-office:locale"
    )
    ctx.lifecycle.onDispose(() => disposeImporter(), "cognia-office:importer")

    for (const tool of createOfficeTools(ctx))
      ctx.lifecycle.onDispose(ctx.agent.registerTool(tool), `cognia-office:tool:${tool.name}`)
    ctx.logger.info("cognia-office plugin activated")
  },
})
