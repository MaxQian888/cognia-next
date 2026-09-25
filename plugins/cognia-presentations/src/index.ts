import {
  defineImporter,
  definePlugin,
  definePluginManifest,
  type PluginContext,
} from "@cognia/plugin-sdk"
import manifestJson from "../plugin.json"
import { createPresentationResultCard } from "./card"
import { PRESENTATION_ARTIFACT_KIND, PPTX_MIME, type PresentationDeck } from "./model"
import { importPptx } from "./pptx"
import { createPresentationRenderer } from "./preview"
import { createPresentationTools, PRESENTATION_TOOL_NAMES } from "./tools"

// plugin.json is the manifest source of truth — including the declarative
// `i18n.locales` bundle, which the manager merges before activate() runs.
export const manifest = definePluginManifest(manifestJson)

type Translate = PluginContext["i18n"]["t"]

function buildImporter(t: Translate) {
  return defineImporter<PresentationDeck>({
    id: "pptx",
    name: t("importer.name"),
    description: t("importer.description"),
    format: "pptx",
    extensions: ["pptx"],
    mimeType: PPTX_MIME,
    import: async (source) => {
      if (typeof source.content === "string")
        return { success: false, error: t("importer.binaryRequired") }
      try {
        return {
          success: true,
          data: await importPptx(new Uint8Array(source.content), source.filename),
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

export default definePlugin({
  manifest,
  activate: async (ctx) => {
    const t: Translate = (key, params) => ctx.i18n.t(key, params)
    ctx.lifecycle.onDispose(
      ctx.artifact.registerRenderer(
        PRESENTATION_ARTIFACT_KIND,
        createPresentationRenderer(t, (handler) => ctx.i18n.onLocaleChange(handler))
      ),
      "cognia-presentations:renderer"
    )
    // Importer labels resolve at registration time — re-register on locale
    // change, matching the cognia-documents convention.
    let disposeImporter = ctx.import.registerImporter(buildImporter(t))
    ctx.lifecycle.onDispose(
      ctx.i18n.onLocaleChange(() => {
        disposeImporter()
        disposeImporter = ctx.import.registerImporter(buildImporter(t))
      }),
      "cognia-presentations:importer-locale"
    )
    ctx.lifecycle.onDispose(() => disposeImporter(), "cognia-presentations:importer")
    for (const tool of createPresentationTools(ctx))
      ctx.lifecycle.onDispose(
        ctx.agent.registerTool(tool),
        `cognia-presentations:tool:${tool.name}`
      )
    // The card reads its strings through `usePluginTranslations`; only the
    // "Open" action needs this activation's context.
    const ResultCard = createPresentationResultCard({
      openArtifact: (artifactId) => ctx.artifact.openArtifact(artifactId),
    })
    for (const name of PRESENTATION_TOOL_NAMES)
      ctx.lifecycle.onDispose(
        ctx.toolResult.registerToolResultRenderer(name, ResultCard),
        `cognia-presentations:result-card:${name}`
      )
    ctx.logger.info("cognia-presentations plugin activated")
  },
})
