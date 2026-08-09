import type { FullPluginContext } from "@cognia/plugin-sdk/context"
import type { PluginArtifactAPI, PluginFilesAPI } from "@/types/plugin"

import { extractPdfPages, fillPdfFields, inspectPdf, type PdfFieldValue } from "./pdf-engine"
import {
  base64ToBytes,
  createPdfArtifactDocument,
  parsePdfArtifact,
  PDF_ARTIFACT_KIND,
  PDF_MIME,
  PDF_SCHEMA_VERSION,
  type PdfArtifactDocument,
} from "./model"

export type PdfPluginContext = Pick<FullPluginContext, "pluginId"> & {
  artifact: PluginArtifactAPI
  files: PluginFilesAPI
}

export interface PdfValidationFinding {
  severity: "error" | "warning"
  code: string
  message: string
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

  async function createArtifact(
    document: PdfArtifactDocument,
    options: { sessionId?: string; messageId?: string }
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
        userInitiated: true,
        previewable: true,
      },
    })
    ctx.artifact.openArtifact(artifactId)
    return artifactId
  }

  return {
    importPdf: async (input: {
      handle?: string
      title?: string
      password?: string
      sessionId?: string
      messageId?: string
    }) => {
      const file = input.handle
        ? await ctx.files.readAttachment(input.handle)
        : (await ctx.files.open({ accept: [".pdf", PDF_MIME], maxBytes: 50 * 1024 * 1024 }))[0]
      if (!file) return { ok: false as const, cancelled: true as const }
      const inspection = await inspectPdf(file.bytes, input.password)
      const title = input.title?.trim() || stripExtension(file.name) || "PDF document"
      const document = createPdfArtifactDocument({
        title,
        sourceFilename: file.name,
        bytes: file.bytes,
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
      const inspection = await inspectPdf(filled.bytes, input.password)
      const updated = createPdfArtifactDocument({
        ...document,
        bytes: filled.bytes,
        inspection,
        expectedValues: { ...document.expectedValues, ...input.values },
      })
      const artifact = ctx.artifact.updateArtifact(input.artifactId, {
        content: JSON.stringify(updated),
        expectedVersion: input.expectedVersion,
        changeDescription: input.changeDescription ?? "Fill PDF form fields",
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
      handles: string[]
      includePages?: Array<number[] | undefined>
      title: string
      sessionId?: string
      messageId?: string
    }) => {
      if (input.handles.length === 0) throw new Error("At least one PDF attachment is required.")
      if (input.includePages && input.includePages.length !== input.handles.length) {
        throw new Error("includePages must align with handles.")
      }
      const files = await Promise.all(
        input.handles.map((handle) => ctx.files.readAttachment(handle))
      )
      const bytes = await extractPdfPages(
        files.map((file, index) => ({
          bytes: file.bytes,
          ...(input.includePages?.[index] ? { includePages: input.includePages[index] } : {}),
        }))
      )
      const inspection = await inspectPdf(bytes)
      const document = createPdfArtifactDocument({ title: input.title, bytes, inspection })
      const artifactId = await createArtifact(document, input)
      return { ok: true as const, artifactId, inspection }
    },

    validate: async (artifactId: string) => {
      const { document } = readArtifact(artifactId)
      const reopened = await inspectPdf(base64ToBytes(document.dataBase64))
      const findings: PdfValidationFinding[] = []
      if (reopened.pageCount !== document.inspection.pageCount) {
        findings.push({
          severity: "error",
          code: "pages.mismatch",
          message: "Saved page count differs from the artifact inspection.",
        })
      }
      for (const [name, expected] of Object.entries(document.expectedValues)) {
        const actual = reopened.fields.find((field) => field.name === name)?.value
        if (JSON.stringify(actual) !== JSON.stringify(expected)) {
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

    preview: (artifactId: string) => {
      readArtifact(artifactId)
      ctx.artifact.openArtifact(artifactId)
      return { ok: true as const, artifactId }
    },

    exportPdf: async (artifactId: string, suggestedName?: string) => {
      const { document } = readArtifact(artifactId)
      const validation = await (async () => {
        const reopened = await inspectPdf(base64ToBytes(document.dataBase64))
        return reopened.pageCount === document.inspection.pageCount
      })()
      if (!validation) throw new Error("PDF validation failed before export.")
      const bytes = base64ToBytes(document.dataBase64)
      const result = await ctx.files.save({
        suggestedName: suggestedName ?? `${safeFilename(document.title)}.pdf`,
        mimeType: PDF_MIME,
        bytes,
      })
      return { ok: result.saved, artifactId, byteLength: bytes.byteLength }
    },
  }
}

function stripExtension(filename: string): string {
  return filename.replace(/\.pdf$/i, "")
}

function safeFilename(value: string): string {
  return value.replace(/[\\/:*?"<>|]/g, "-").trim() || "document"
}
