import type { FullPluginContext } from "@cognia/plugin-sdk/context"
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

export type DocumentsPluginContext = Pick<
  FullPluginContext,
  "pluginId" | "artifact" | "files" | "export"
>

export interface DocumentProgress {
  signal?: AbortSignal
  reportProgress?: (progress: number, message?: string) => void
}

function assertActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError")
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
    importDocx: async (
      input: {
        handle?: string
        title?: string
        sessionId?: string
        messageId?: string
      },
      progress?: DocumentProgress
    ) => {
      assertActive(progress?.signal)
      progress?.reportProgress?.(10, "Reading DOCX file")
      const file = input.handle
        ? await ctx.files.readAttachment(input.handle)
        : (
            await ctx.files.open({
              accept: [".docx", DOCX_MIME],
              maxBytes: 50 * 1024 * 1024,
            })
          )[0]
      if (!file) return { ok: false as const, cancelled: true as const }
      assertActive(progress?.signal)
      progress?.reportProgress?.(40, "Parsing DOCX structure")
      const model = await importDocx(file.bytes, file.name)
      if (input.title?.trim()) model.title = input.title.trim()
      assertActive(progress?.signal)
      progress?.reportProgress?.(80, "Creating document artifact")
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
        title: updated.title,
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
    validate: async (artifactId: string, progress?: DocumentProgress) => {
      const { model } = read(artifactId)
      progress?.reportProgress?.(20, "Validating document model")
      const findings = validateDocument(model)
      assertActive(progress?.signal)
      progress?.reportProgress?.(60, "Generating DOCX package")
      const bytes = await exportDocx(model)
      assertActive(progress?.signal)
      const reopened = await validateDocxRoundTrip(bytes)
      if (!reopened.valid)
        findings.push({
          severity: "error",
          code: "docx.invalid",
          message: "Generated DOCX could not be reopened.",
        })
      progress?.reportProgress?.(100)
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
    listVersions: (artifactId: string) => {
      const { artifact } = read(artifactId)
      const versions = ctx.artifact.listVersions(artifactId).map((version) => ({
        versionId: version.id,
        version: version.version,
        title: version.title,
        createdAt: version.createdAt,
        changeDescription: version.changeDescription,
      }))
      return {
        ok: true as const,
        artifactId,
        currentVersion: artifact.version,
        versions,
      }
    },
    restoreVersion: (input: { artifactId: string; versionId: string; expectedVersion: number }) => {
      read(input.artifactId)
      const artifact = ctx.artifact.restoreVersion(
        input.artifactId,
        input.versionId,
        input.expectedVersion
      )
      ctx.artifact.openArtifact(input.artifactId)
      return {
        ok: true as const,
        artifactId: input.artifactId,
        version: artifact.version,
        model: parseDocument(artifact.content),
      }
    },
    exportDocx: async (
      artifactId: string,
      suggestedName?: string,
      allowUnsupportedFeatureLoss = false,
      progress?: DocumentProgress
    ) => {
      const { model } = read(artifactId)
      if (model.importedFeatures.length > 0 && !allowUnsupportedFeatureLoss) {
        throw new Error(
          `Export would discard unsupported imported features: ${model.importedFeatures.join(
            ", "
          )}. Set allowUnsupportedFeatureLoss only after user confirmation.`
        )
      }
      assertActive(progress?.signal)
      progress?.reportProgress?.(30, "Generating DOCX package")
      const bytes = await exportDocx(model)
      const reopened = await validateDocxRoundTrip(bytes)
      if (!reopened.valid) throw new Error("DOCX validation failed before export.")
      assertActive(progress?.signal)
      progress?.reportProgress?.(80, "Saving DOCX file")
      const result = await ctx.files.save({
        suggestedName: normalizeDocxName(suggestedName ?? model.title),
        mimeType: DOCX_MIME,
        bytes,
      })
      return { ok: result.saved, artifactId, byteLength: bytes.byteLength }
    },
    exportTranscript: async (
      input: { sessionId: string; suggestedName?: string },
      progress?: DocumentProgress
    ) => {
      assertActive(progress?.signal)
      progress?.reportProgress?.(20, "Generating DOCX transcript")
      const result = await ctx.export.exportSession(input.sessionId, { format: "docx" })
      if (!result.success || !result.blob)
        return {
          ok: false as const,
          error: result.error ?? "Transcript export failed.",
        }
      assertActive(progress?.signal)
      const bytes = new Uint8Array(await result.blob.arrayBuffer())
      const saved = await ctx.files.save({
        suggestedName: normalizeDocxName(input.suggestedName ?? result.filename ?? "transcript"),
        mimeType: DOCX_MIME,
        bytes,
      })
      return {
        ok: saved.saved,
        filename: result.filename,
        byteLength: bytes.byteLength,
      }
    },
  }
}

export function normalizeDocxName(value: string): string {
  const base = safeFilename(value.replace(/\.docx$/i, ""))
  return `${base}.docx`
}

function safeFilename(value: string) {
  return value.replace(/[\\/:*?"<>|]/g, "-").trim() || "document"
}
