import type { PluginContext } from "@cognia/plugin-sdk"
import { normalizeExportName, summarizeSave } from "./export-file"
import {
  extractPdfPages,
  fillPdfFields,
  inspectPdf,
  pdfFieldValueMatches,
  type PdfFieldValue,
} from "./pdf-engine"
import {
  base64ToBytes,
  createPdfArtifactDocument,
  parsePdfArtifact,
  PDF_ARTIFACT_KIND,
  PDF_MAX_BYTES,
  PDF_MIME,
  PDF_SCHEMA_VERSION,
  type PdfArtifactDocument,
} from "./model"

export type PdfPluginContext = Pick<PluginContext, "artifact" | "files" | "ocr" | "i18n">

/** A `.pdf` filename `ctx.files.save` accepts, built from a title or model-supplied name. */
export function normalizePdfName(value: string | undefined): string {
  return normalizeExportName(value, "pdf", "document")
}

export interface PdfValidationFinding {
  severity: "error" | "warning"
  code: string
  message: string
}

/** One page source for `extract` — an authorized attachment or a PDF artifact. */
export interface PdfExtractSource {
  handle?: string
  artifactId?: string
  includePages?: number[]
  password?: string
}

export function createPdfRuntime(ctx: PdfPluginContext) {
  function readArtifact(artifactId: string) {
    const artifact = ctx.artifact.getArtifact(artifactId)
    if (!artifact) throw new Error(`PDF artifact not found: ${artifactId}`)
    if (artifact.metadata?.plugin?.kind !== PDF_ARTIFACT_KIND) {
      throw new Error(`Artifact is not a Cognia PDF: ${artifactId}`)
    }
    return { artifact, document: parsePdfArtifact(artifact.content) }
  }

  function readSourceBytes(source: { handle?: string; artifactId?: string }) {
    if (source.handle && source.artifactId) {
      throw new Error("PDF source must specify either handle or artifactId, not both.")
    }
    if (source.handle) return ctx.files.readAttachment(source.handle).then((file) => file.bytes)
    if (source.artifactId) {
      const { document } = readArtifact(source.artifactId)
      return Promise.resolve(base64ToBytes(document.dataBase64))
    }
    throw new Error("PDF source requires a handle or an artifactId.")
  }

  async function createArtifact(
    document: PdfArtifactDocument,
    options: { sessionId?: string; messageId?: string; userInitiated?: boolean }
  ) {
    const artifactId = await ctx.artifact.createArtifact({
      title: document.title,
      content: JSON.stringify(document),
      type: "code",
      language: "json",
      kind: PDF_ARTIFACT_KIND,
      schemaVersion: PDF_SCHEMA_VERSION,
      sessionId: options.sessionId,
      messageId: options.messageId,
      metadata: {
        sourceOrigin: "tool",
        // Agent tool calls create artifacts on the model's behalf; only the
        // host import flow (the user picked a file) passes `true`.
        userInitiated: options.userInitiated ?? false,
        previewable: true,
      },
    })
    ctx.artifact.openArtifact(artifactId)
    return artifactId
  }

  const api = {
    importPdf: async (input: {
      handle?: string
      title?: string
      password?: string
      sessionId?: string
      messageId?: string
    }) => {
      const file = input.handle
        ? await ctx.files.readAttachment(input.handle)
        : (
            await ctx.files.open({
              accept: [".pdf", PDF_MIME],
              maxBytes: PDF_MAX_BYTES,
            })
          )[0]
      if (!file) return { ok: false as const, cancelled: true as const }
      if (file.bytes.byteLength > PDF_MAX_BYTES) {
        return {
          ok: false as const,
          error: `PDF exceeds the ${Math.floor(PDF_MAX_BYTES / 1024 / 1024)}MB size limit: ${file.name}`,
        }
      }
      return api.importPdfBytes({
        bytes: file.bytes,
        filename: file.name,
        title: input.title,
        password: input.password,
        sessionId: input.sessionId,
        messageId: input.messageId,
      })
    },

    /** Shared by the agent tool and the content importer (source bytes in hand). */
    importPdfBytes: async (input: {
      bytes: Uint8Array
      filename?: string
      title?: string
      password?: string
      sessionId?: string
      messageId?: string
      userInitiated?: boolean
    }) => {
      const inspection = await inspectPdf(input.bytes, input.password)
      const title =
        input.title?.trim() ||
        (input.filename ? stripExtension(input.filename) : "") ||
        ctx.i18n.t("import.untitled")
      const document = createPdfArtifactDocument({
        title,
        ...(input.filename ? { sourceFilename: input.filename } : {}),
        bytes: input.bytes,
        inspection,
      })
      const artifactId = await createArtifact(document, input)
      return { ok: true as const, artifactId, inspection }
    },

    inspect: (artifactId: string) => {
      const { artifact, document } = readArtifact(artifactId)
      return {
        ok: true as const,
        artifactId,
        version: artifact.version,
        title: document.title,
        sourceFilename: document.sourceFilename,
        ...document.inspection,
      }
    },

    fill: async (input: {
      artifactId: string
      expectedVersion: number
      values: Record<string, PdfFieldValue>
      password?: string
      changeDescription?: string
    }) => {
      const { document } = readArtifact(input.artifactId)
      const filled = await fillPdfFields(base64ToBytes(document.dataBase64), input.values, {
        password: input.password,
      })
      const updated = createPdfArtifactDocument({
        ...document,
        bytes: filled.bytes,
        inspection: filled.inspection,
        expectedValues: { ...document.expectedValues, ...input.values },
      })
      const artifact = ctx.artifact.updateArtifact(input.artifactId, {
        content: JSON.stringify(updated),
        expectedVersion: input.expectedVersion,
        changeDescription: input.changeDescription ?? ctx.i18n.t("history.fill"),
      })
      ctx.artifact.openArtifact(input.artifactId)
      return {
        ok: true as const,
        artifactId: input.artifactId,
        version: artifact.version,
        verifiedValues: filled.verifiedValues,
      }
    },

    extract: async (input: {
      sources: PdfExtractSource[]
      title: string
      sessionId?: string
      messageId?: string
    }) => {
      if (input.sources.length === 0) throw new Error("At least one PDF source is required.")
      const sources = await Promise.all(
        input.sources.map(async (source) => ({
          bytes: await readSourceBytes(source),
          ...(source.includePages ? { includePages: source.includePages } : {}),
          ...(source.password ? { password: source.password } : {}),
        }))
      )
      const bytes = await extractPdfPages(sources)
      const inspection = await inspectPdf(bytes)
      const document = createPdfArtifactDocument({ title: input.title, bytes, inspection })
      const artifactId = await createArtifact(document, input)
      return { ok: true as const, artifactId, inspection }
    },

    validate: async (artifactId: string, password?: string) => {
      const { document } = readArtifact(artifactId)
      if (document.inspection.encrypted && !password) {
        return {
          ok: true as const,
          skippedReopen: true as const,
          artifactId,
          findings: [
            {
              severity: "warning" as const,
              code: "pdf.encrypted",
              message:
                "Document is encrypted; reopen checks were skipped. Pass the password to validate field values.",
            },
          ],
          inspection: document.inspection,
        }
      }
      const reopened = await inspectPdf(base64ToBytes(document.dataBase64), password)
      const findings: PdfValidationFinding[] = []
      if (reopened.pageCount !== document.inspection.pageCount) {
        findings.push({
          severity: "error",
          code: "pages.mismatch",
          message: "Saved page count differs from the artifact inspection.",
        })
      }
      for (const [name, expected] of Object.entries(document.expectedValues)) {
        const field = reopened.fields.find((entry) => entry.name === name)
        if (!field || !pdfFieldValueMatches(field, expected)) {
          findings.push({
            severity: "error",
            code: "field.value_mismatch",
            message: `Saved field value does not match: ${name}`,
          })
        }
      }
      for (const warning of reopened.warnings) {
        findings.push({ severity: "warning", code: "pdf.warning", message: warning })
      }
      return {
        ok: !findings.some((finding) => finding.severity === "error"),
        artifactId,
        findings,
        inspection: reopened,
      }
    },

    extractText: async (input: {
      artifactId?: string
      handle?: string
      pageRange?: string
      format?: "markdown" | "text" | "blocks"
      languages?: string[]
    }) => {
      const bytes = await readSourceBytes(input)
      const result = await ctx.ocr.extract({
        source: {
          kind: "blob",
          blob: new Blob([new Uint8Array(bytes)], { type: PDF_MIME }),
          mimeType: PDF_MIME,
        },
        ...(input.pageRange ? { pageRange: input.pageRange } : {}),
        ...(input.format ? { format: input.format } : {}),
        ...(input.languages ? { languages: input.languages } : {}),
      })
      return {
        ok: true as const,
        providerId: result.providerId,
        cached: result.cached,
        text: result.combinedText,
        markdown: result.combinedMarkdown,
        pages: result.pages.map((page) => ({
          pageNumber: page.pageNumber,
          text: page.text,
          fromTextLayer: page.fromTextLayer ?? false,
        })),
      }
    },

    preview: (artifactId: string) => {
      readArtifact(artifactId)
      ctx.artifact.openArtifact(artifactId)
      return { ok: true as const, artifactId }
    },

    exportPdf: async (artifactId: string, suggestedName?: string, password?: string) => {
      const { document } = readArtifact(artifactId)
      const bytes = base64ToBytes(document.dataBase64)
      // Re-open validation only makes sense for documents we can parse; encrypted
      // bytes without a password are exported as stored.
      if (!document.inspection.encrypted || password) {
        const reopened = await inspectPdf(bytes, password)
        if (reopened.pageCount !== document.inspection.pageCount) {
          return {
            ok: false as const,
            artifactId,
            error:
              "The stored PDF no longer reopens with its recorded page count; nothing was saved.",
          }
        }
      }
      const filename = normalizePdfName(suggestedName ?? document.title)
      const outcome = await ctx.files.save({ suggestedName: filename, mimeType: PDF_MIME, bytes })
      return { ...summarizeSave(outcome, filename), artifactId, byteLength: bytes.byteLength }
    },
  }

  return api
}

function stripExtension(filename: string): string {
  return filename.replace(/\.pdf$/i, "")
}
