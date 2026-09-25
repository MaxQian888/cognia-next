import {
  defineExporter,
  defineImporter,
  definePlugin,
  definePluginManifest,
  type PluginContext,
} from "@cognia/plugin-sdk"
import manifestJson from "../plugin.json"
import { exportTranscriptDocx, importDocx } from "./docx"
import { DOCUMENT_ARTIFACT_KIND, DOCX_MIME } from "./model"
import { createDocumentRenderer } from "./preview"
import { createDocumentsRuntime, docxImportLabels } from "./runtime"
import { createDocumentTools } from "./tools"

// plugin.json is the manifest source of truth — including the `i18n.locales`
// bundle the manager registers before activate() runs.
export const manifest = definePluginManifest(manifestJson)

type Translate = PluginContext["i18n"]["t"]

function buildImporter(t: Translate) {
  return defineImporter({
    id: "docx",
    name: t("importer.name"),
    description: t("importer.description"),
    format: "docx",
    extensions: ["docx"],
    mimeType: DOCX_MIME,
    import: async (source) => {
      if (typeof source.content === "string")
        return { success: false, error: t("importer.binaryRequired") }
      try {
        return {
          success: true,
          data: await importDocx(
            new Uint8Array(source.content),
            source.filename,
            docxImportLabels(t)
          ),
        }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : t("importer.failed"),
        }
      }
    },
  })
}

function buildExporter(t: Translate) {
  return defineExporter({
    id: "docx",
    name: t("exporter.name"),
    description: t("exporter.description"),
    format: "docx",
    extension: "docx",
    mimeType: DOCX_MIME,
    export: (data) =>
      exportTranscriptDocx(data, {
        title: t("transcript.title"),
        user: t("transcript.user"),
        assistant: t("transcript.assistant"),
        system: t("transcript.system"),
      }),
  })
}

export default definePlugin({
  manifest,
  activate: async (ctx) => {
    const t: Translate = (key, params) => ctx.i18n.t(key, params)
    const runtime = createDocumentsRuntime(ctx)

    ctx.lifecycle.onDispose(
      ctx.artifact.registerRenderer(
        DOCUMENT_ARTIFACT_KIND,
        createDocumentRenderer({
          t,
          applyReview: (artifactId, expectedVersion, operations) =>
            runtime.apply({
              artifactId,
              expectedVersion,
              operations,
              changeDescription: t("review.changeDescription"),
            }),
          onLocaleChange: (handler) => ctx.i18n.onLocaleChange(handler),
        })
      ),
      "cognia-documents:renderer"
    )

    // Importer/exporter labels are resolved at registration time, so
    // re-register them when the locale changes.
    let disposeImporter = ctx.import.registerImporter(buildImporter(t))
    let disposeExporter = ctx.export.registerExporter(buildExporter(t))
    ctx.lifecycle.onDispose(
      ctx.i18n.onLocaleChange(() => {
        disposeImporter()
        disposeExporter()
        disposeImporter = ctx.import.registerImporter(buildImporter(t))
        disposeExporter = ctx.export.registerExporter(buildExporter(t))
      }),
      "cognia-documents:locale"
    )
    ctx.lifecycle.onDispose(() => disposeImporter(), "cognia-documents:importer")
    ctx.lifecycle.onDispose(() => disposeExporter(), "cognia-documents:exporter")

    for (const tool of createDocumentTools(ctx))
      ctx.lifecycle.onDispose(ctx.agent.registerTool(tool), `cognia-documents:tool:${tool.name}`)
    ctx.logger.info("cognia-documents plugin activated")
  },
})
