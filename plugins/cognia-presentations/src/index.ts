import { defineImporter, definePluginManifest, type PluginDefinition } from "@cognia/plugin-sdk"
import manifestJson from "../plugin.json"
import { PresentationResultCard, setPresentationResultBridge } from "./card"
import { PRESENTATION_ARTIFACT_KIND, PPTX_MIME, type PresentationDeck } from "./model"
import { importPptx } from "./pptx"
import { createPresentationRenderer } from "./preview"
import { createPresentationTools, PRESENTATION_TOOL_NAMES } from "./tools"

// plugin.json is the manifest source of truth — including the declarative
// `i18n.locales` bundle, which the manager merges before activate() runs.
export const manifest = definePluginManifest(manifestJson)

function buildImporter(t: (key: string, vars?: Record<string, string | number>) => string) {
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

const definition: PluginDefinition = {
  manifest,
  activate: async (ctx) => {
    const t = (key: string, vars?: Record<string, string | number>) => ctx.i18n.t(key, vars)
    ctx.artifact.registerRenderer(
      PRESENTATION_ARTIFACT_KIND,
      createPresentationRenderer(t, (handler) => ctx.i18n.onLocaleChange(handler))
    )
    // Importer labels resolve at registration time — re-register on locale
    // change, matching the cognia-documents convention.
    let disposeImporter = ctx.import.registerImporter(buildImporter(t))
    ctx.lifecycle?.onDispose?.(
      ctx.i18n.onLocaleChange(() => {
        disposeImporter()
        disposeImporter = ctx.import.registerImporter(buildImporter(t))
      }),
      "cognia-presentations:importer-locale"
    )
    ctx.lifecycle?.onDispose?.(() => disposeImporter(), "cognia-presentations:importer")
    for (const tool of createPresentationTools(ctx)) ctx.agent.registerTool(tool)
    setPresentationResultBridge({
      t,
      openArtifact: (artifactId) => ctx.artifact.openArtifact(artifactId),
    })
    ctx.lifecycle?.onDispose?.(
      () => setPresentationResultBridge(null),
      "cognia-presentations:result-bridge"
    )
    for (const name of PRESENTATION_TOOL_NAMES)
      ctx.toolResult?.registerToolResultRenderer?.(name, PresentationResultCard)
    ctx.logger.info("cognia-presentations plugin activated")
  },
}
export default definition
