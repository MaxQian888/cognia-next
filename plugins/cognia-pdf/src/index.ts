import {
  defineImporter,
  definePlugin,
  definePluginManifest,
  type PluginContext,
} from "@cognia/plugin-sdk"
import manifestJson from "../plugin.json"
import { PDF_ARTIFACT_KIND, PDF_MIME } from "./model"
import { createPdfRenderer } from "./preview"
import { createPdfRuntime } from "./runtime"
import { createPdfTools } from "./tools"

// plugin.json is the manifest source of truth — including the `i18n.locales`
// bundle the manager registers before activate() runs.
export const manifest = definePluginManifest(manifestJson)

type Translate = PluginContext["i18n"]["t"]

export default definePlugin({
  manifest,
  activate: async (ctx) => {
    const t: Translate = (key, params) => ctx.i18n.t(key, params)
    const runtime = createPdfRuntime(ctx)

    ctx.lifecycle.onDispose(
      ctx.artifact.registerRenderer(
        PDF_ARTIFACT_KIND,
        createPdfRenderer({
          t,
          onLocaleChange: (handler) => ctx.i18n.onLocaleChange(handler),
          save: (file) => ctx.files.save(file),
        })
      ),
      "cognia-pdf:renderer"
    )

    const buildImporter = () =>
      defineImporter({
        id: "pdf",
        name: t("importer.name"),
        description: t("importer.description"),
        format: "pdf",
        extensions: ["pdf"],
        mimeType: PDF_MIME,
        import: async (source) => {
          if (typeof source.content === "string")
            return { success: false, error: t("importer.binaryRequired") }
          try {
            // Import means "become a PDF artifact": the document model (bytes +
            // inspection) is what preview/fill/export all operate on. The user
            // chose this file in the host import flow, so the artifact is theirs.
            return {
              success: true,
              data: await runtime.importPdfBytes({
                bytes: new Uint8Array(source.content),
                filename: source.filename,
                userInitiated: true,
              }),
            }
          } catch (error) {
            return {
              success: false,
              error: error instanceof Error ? error.message : t("importer.failed"),
            }
          }
        },
      })
    // Importer labels are resolved at registration time — re-register on a
    // locale change.
    let disposeImporter = ctx.import.registerImporter(buildImporter())
    ctx.lifecycle.onDispose(
      ctx.i18n.onLocaleChange(() => {
        disposeImporter()
        disposeImporter = ctx.import.registerImporter(buildImporter())
      }),
      "cognia-pdf:locale"
    )
    ctx.lifecycle.onDispose(() => disposeImporter(), "cognia-pdf:importer")

    for (const tool of createPdfTools(ctx))
      ctx.lifecycle.onDispose(ctx.agent.registerTool(tool), `cognia-pdf:tool:${tool.name}`)
    ctx.logger.info("cognia-pdf plugin activated")
  },
})
