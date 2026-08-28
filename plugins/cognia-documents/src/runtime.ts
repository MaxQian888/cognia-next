import type { FullPluginContext } from "@cognia/plugin-sdk/context"
import type { PluginArtifactAPI, PluginFilesAPI } from "@cognia/plugin-sdk"
import { exportDocx, importDocx, validateDocxRoundTrip } from "./docx"
import {
  applyDocumentOperations,
  createDocument,
  DOCUMENT_ARTIFACT_KIND,
  DOCUMENT_SCHEMA_VERSION,
  DOCX_MIME,
  parseDocument,
  validateDocument,
  type DocumentModel,
  type DocumentOperation,
} from "./model"

export type DocumentsPluginContext = Pick<FullPluginContext, "pluginId"> & {
  artifact: PluginArtifactAPI
  files: PluginFilesAPI
}

export function createDocumentsRuntime(ctx: DocumentsPluginContext) {
  const read = (artifactId: string) => {
    const artifact = ctx.artifact.getArtifact(artifactId)
    if (!artifact) throw new Error(`Document artifact not found: ${artifactId}`)
    if (artifact.metadata?.plugin?.kind !== DOCUMENT_ARTIFACT_KIND)
      throw new Error(`Artifact is not a Cognia document: ${artifactId}`)
    return { artifact, model: parseDocument(artifact.content) }
  }
  const createArtifact = async (
    model: DocumentModel,
    options: { sessionId?: string; messageId?: string }
  ) => {
    const artifactId = await ctx.artifact.createArtifact({
      title: model.title,
      content: JSON.stringify(model),
      type: "document",
      language: "json",
      kind: DOCUMENT_ARTIFACT_KIND,
      schemaVersion: DOCUMENT_SCHEMA_VERSION,
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
      text?: string
      operations?: DocumentOperation[]
      sessionId?: string
      messageId?: string
    }) => {
      const model = applyDocumentOperations(
        createDocument(input.title, input.text),
        input.operations ?? []
      )
      return { ok: true as const, artifactId: await createArtifact(model, input), model }
    },
    importDocx: async (input: {
      handle?: string
      title?: string
      sessionId?: string
      messageId?: string
    }) => {
      const file = input.handle
        ? await ctx.files.readAttachment(input.handle)
        : (await ctx.files.open({ accept: [".docx", DOCX_MIME], maxBytes: 50 * 1024 * 1024 }))[0]
      if (!file) return { ok: false as const, cancelled: true as const }
      const model = await importDocx(file.bytes, file.name)
      if (input.title?.trim()) model.title = input.title.trim()
      return { ok: true as const, artifactId: await createArtifact(model, input), model }
    },
    inspect: (artifactId: string) => {
      const { artifact, model } = read(artifactId)
      return {
        ok: true as const,
        artifactId,
        version: artifact.version,
        model,
        findings: validateDocument(model),
      }
    },
    apply: async (input: {
      artifactId: string
      expectedVersion: number
      operations: DocumentOperation[]
      changeDescription?: string
    }) => {
      const { model } = read(input.artifactId)
      const updated = applyDocumentOperations(model, input.operations)
      const artifact = ctx.artifact.updateArtifact(input.artifactId, {
        content: JSON.stringify(updated),
        expectedVersion: input.expectedVersion,
        changeDescription: input.changeDescription ?? "Edit document",
      })
      ctx.artifact.openArtifact(input.artifactId)
      return {
        ok: true as const,
        artifactId: input.artifactId,
        version: artifact.version,
        findings: validateDocument(updated),
      }
    },
    validate: async (artifactId: string) => {
      const { model } = read(artifactId)
      const findings = validateDocument(model)
      const bytes = await exportDocx(model)
      const reopened = await validateDocxRoundTrip(bytes)
      if (!reopened.valid)
        findings.push({
          severity: "error",
          code: "docx.invalid",
          message: "Generated DOCX could not be reopened.",
        })
      return {
        ok: !findings.some((finding) => finding.severity === "error"),
        artifactId,
        findings,
        byteLength: bytes.byteLength,
      }
    },
    preview: (artifactId: string) => {
      read(artifactId)
      ctx.artifact.openArtifact(artifactId)
      return { ok: true as const, artifactId }
    },
    exportDocx: async (
      artifactId: string,
      suggestedName?: string,
      allowUnsupportedFeatureLoss = false
    ) => {
      const { model } = read(artifactId)
      if (model.importedFeatures.length > 0 && !allowUnsupportedFeatureLoss) {
        throw new Error(
          `Export would discard unsupported imported features: ${model.importedFeatures.join(
            ", "
          )}. Set allowUnsupportedFeatureLoss only after user confirmation.`
        )
      }
      const bytes = await exportDocx(model)
      const reopened = await validateDocxRoundTrip(bytes)
      if (!reopened.valid) throw new Error("DOCX validation failed before export.")
      const result = await ctx.files.save({
        suggestedName: suggestedName ?? `${safeFilename(model.title)}.docx`,
        mimeType: DOCX_MIME,
        bytes,
      })
      return { ok: result.saved, artifactId, byteLength: bytes.byteLength }
    },
  }
}

function safeFilename(value: string) {
  return value.replace(/[\\/:*?"<>|]/g, "-").trim() || "document"
}
