import type { FullPluginContext } from "@cognia/plugin-sdk/context"
import type { PluginArtifactAPI, PluginFilesAPI } from "@cognia/plugin-sdk"
import {
  applyPresentationOperations,
  createPresentation,
  parsePresentation,
  PRESENTATION_ARTIFACT_KIND,
  PRESENTATION_SCHEMA_VERSION,
  PPTX_MIME,
  validatePresentation,
  type PresentationDeck,
  type PresentationOperation,
} from "./model"
import { exportPptx, importPptx, validatePptxRoundTrip } from "./pptx"

export type PresentationsPluginContext = Pick<FullPluginContext, "pluginId"> & {
  artifact: PluginArtifactAPI
  files: PluginFilesAPI
}
export function createPresentationsRuntime(ctx: PresentationsPluginContext) {
  const read = (artifactId: string) => {
    const artifact = ctx.artifact.getArtifact(artifactId)
    if (!artifact) throw new Error(`Presentation artifact not found: ${artifactId}`)
    if (artifact.metadata?.plugin?.kind !== PRESENTATION_ARTIFACT_KIND)
      throw new Error(`Artifact is not a Cognia presentation: ${artifactId}`)
    return { artifact, deck: parsePresentation(artifact.content) }
  }
  const createArtifact = async (
    deck: PresentationDeck,
    options: { sessionId?: string; messageId?: string }
  ) => {
    const artifactId = await ctx.artifact.createArtifact({
      title: deck.title,
      content: JSON.stringify(deck),
      type: "document",
      language: "json",
      kind: PRESENTATION_ARTIFACT_KIND,
      schemaVersion: PRESENTATION_SCHEMA_VERSION,
      sessionId: options.sessionId,
      messageId: options.messageId,
      metadata: {
        sourceOrigin: "tool",
        userInitiated: true,
        previewable: true,
      },
    })
    ctx.artifact.openArtifact(artifactId)
    return artifactId
  }
  return {
    create: async (input: {
      title: string
      operations?: PresentationOperation[]
      sessionId?: string
      messageId?: string
    }) => {
      const deck = applyPresentationOperations(
        createPresentation(input.title),
        input.operations ?? []
      )
      return {
        ok: true as const,
        artifactId: await createArtifact(deck, input),
        deck,
        findings: validatePresentation(deck),
      }
    },
    importPptx: async (input: {
      handle?: string
      title?: string
      sessionId?: string
      messageId?: string
    }) => {
      const file = input.handle
        ? await ctx.files.readAttachment(input.handle)
        : (await ctx.files.open({ accept: [".pptx", PPTX_MIME], maxBytes: 100 * 1024 * 1024 }))[0]
      if (!file) return { ok: false as const, cancelled: true as const }
      const deck = await importPptx(file.bytes, file.name)
      if (input.title?.trim()) deck.title = input.title.trim()
      return {
        ok: true as const,
        artifactId: await createArtifact(deck, input),
        deck,
        findings: validatePresentation(deck),
      }
    },
    inspect: (artifactId: string) => {
      const { artifact, deck } = read(artifactId)
      return {
        ok: true as const,
        artifactId,
        version: artifact.version,
        deck,
        findings: validatePresentation(deck),
      }
    },
    apply: (input: {
      artifactId: string
      expectedVersion: number
      operations: PresentationOperation[]
      changeDescription?: string
    }) => {
      const { deck } = read(input.artifactId)
      const updated = applyPresentationOperations(deck, input.operations)
      const artifact = ctx.artifact.updateArtifact(input.artifactId, {
        content: JSON.stringify(updated),
        expectedVersion: input.expectedVersion,
        changeDescription: input.changeDescription ?? "Edit presentation",
      })
      ctx.artifact.openArtifact(input.artifactId)
      return {
        ok: true as const,
        artifactId: input.artifactId,
        version: artifact.version,
        findings: validatePresentation(updated),
      }
    },
    validate: async (artifactId: string) => {
      const { deck } = read(artifactId)
      const findings = validatePresentation(deck)
      if (!findings.some((finding) => finding.severity === "error")) {
        const bytes = await exportPptx(deck)
        const reopened = await validatePptxRoundTrip(bytes)
        if (!reopened.valid || reopened.slideCount !== deck.slides.length)
          findings.push({
            severity: "error",
            code: "pptx.roundtrip",
            message: "Generated PPTX did not reopen with the expected slide count.",
          })
      }
      return { ok: !findings.some((finding) => finding.severity === "error"), artifactId, findings }
    },
    preview: (artifactId: string) => {
      read(artifactId)
      ctx.artifact.openArtifact(artifactId)
      return { ok: true as const, artifactId }
    },
    exportPptx: async (
      artifactId: string,
      suggestedName?: string,
      allowUnsupportedFeatureLoss = false
    ) => {
      const { deck } = read(artifactId)
      if (deck.importedFeatures.length > 0 && !allowUnsupportedFeatureLoss) {
        throw new Error(
          `Export would discard unsupported imported features: ${deck.importedFeatures.join(
            ", "
          )}. Set allowUnsupportedFeatureLoss only after user confirmation.`
        )
      }
      const findings = validatePresentation(deck)
      if (findings.some((finding) => finding.severity === "error"))
        throw new Error("Presentation validation failed before export.")
      const bytes = await exportPptx(deck)
      const reopened = await validatePptxRoundTrip(bytes)
      if (!reopened.valid || reopened.slideCount !== deck.slides.length)
        throw new Error("PPTX round-trip validation failed before export.")
      const result = await ctx.files.save({
        suggestedName: suggestedName ?? `${safe(deck.title)}.pptx`,
        mimeType: PPTX_MIME,
        bytes,
      })
      return { ok: result.saved, artifactId, byteLength: bytes.byteLength }
    },
  }
}
function safe(value: string) {
  return value.replace(/[\\/:*?"<>|]/g, "-").trim() || "presentation"
}
