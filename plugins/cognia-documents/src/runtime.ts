import type { PluginContext } from "@cognia/plugin-sdk"
import { exportDocx, importDocx, validateDocxRoundTrip, type DocxImportLabels } from "./docx"
import { normalizeExportName, summarizeSave } from "./export-file"
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

export type DocumentsPluginContext = Pick<PluginContext, "artifact" | "files" | "export" | "i18n">

export interface DocumentProgress {
  signal?: AbortSignal
  reportProgress?: (progress: number, message?: string) => void
}

function assertActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError")
}

/** The importer's user-visible defaults, resolved in the active locale. */
export function docxImportLabels(t: PluginContext["i18n"]["t"]): DocxImportLabels {
  return {
    emptyComment: t("import.emptyComment"),
    unknownAuthor: t("import.unknownAuthor"),
    untitled: t("import.untitled"),
  }
}

export function createDocumentsRuntime(ctx: DocumentsPluginContext) {
  const t = (key: string, params?: Record<string, string | number>) => ctx.i18n.t(key, params)
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
        // Every artifact this runtime creates comes from an agent tool call.
        userInitiated: false,
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
      progress?.reportProgress?.(10, t("progress.readingDocx"))
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
      progress?.reportProgress?.(40, t("progress.parsingDocx"))
      const model = await importDocx(
        file.bytes,
        file.name,
        docxImportLabels(ctx.i18n.t),
        input.title
      )
      assertActive(progress?.signal)
      progress?.reportProgress?.(80, t("progress.creatingArtifact"))
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
        changeDescription: input.changeDescription ?? t("history.edit"),
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
      progress?.reportProgress?.(20, t("progress.validatingModel"))
      const findings = validateDocument(model)
      assertActive(progress?.signal)
      progress?.reportProgress?.(60, t("progress.generatingDocx"))
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
        return {
          ok: false as const,
          artifactId,
          requiresConfirmation: true as const,
          unsupportedFeatures: model.importedFeatures,
          error: `Export would discard unsupported imported features: ${model.importedFeatures.join(
            ", "
          )}. Ask the user to confirm, then retry with allowUnsupportedFeatureLoss: true.`,
        }
      }
      assertActive(progress?.signal)
      progress?.reportProgress?.(30, t("progress.generatingDocx"))
      const bytes = await exportDocx(model)
      const reopened = await validateDocxRoundTrip(bytes)
      if (!reopened.valid)
        return {
          ok: false as const,
          artifactId,
          error: "The generated DOCX did not reopen cleanly, so nothing was saved.",
        }
      assertActive(progress?.signal)
      progress?.reportProgress?.(80, t("progress.savingDocx"))
      const filename = normalizeDocxName(suggestedName ?? model.title)
      const outcome = await ctx.files.save({ suggestedName: filename, mimeType: DOCX_MIME, bytes })
      return { ...summarizeSave(outcome, filename), artifactId, byteLength: bytes.byteLength }
    },
    exportTranscript: async (
      input: { sessionId: string; suggestedName?: string },
      progress?: DocumentProgress
    ) => {
      assertActive(progress?.signal)
      progress?.reportProgress?.(20, t("progress.generatingTranscript"))
      const result = await ctx.export.exportSession(input.sessionId, { format: "docx" })
      if (!result.success || !result.blob)
        return {
          ok: false as const,
          error: result.error ?? "Transcript export failed.",
        }
      assertActive(progress?.signal)
      progress?.reportProgress?.(70, t("progress.savingTranscript"))
      const bytes = new Uint8Array(await result.blob.arrayBuffer())
      const filename = normalizeDocxName(input.suggestedName ?? result.filename ?? "transcript")
      const outcome = await ctx.files.save({ suggestedName: filename, mimeType: DOCX_MIME, bytes })
      return { ...summarizeSave(outcome, filename), byteLength: bytes.byteLength }
    },
  }
}

/** A `.docx` filename `ctx.files.save` accepts, built from a title or model-supplied name. */
export function normalizeDocxName(value: string): string {
  return normalizeExportName(value, "docx", "document")
}
