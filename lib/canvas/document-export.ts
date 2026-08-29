/**
 * Canvas document export.
 *
 * Reuses the Artifacts export contract (`getArtifactExportFormats`, via the
 * Canvas→Artifact projector) to decide which file formats a document can be
 * saved as. `raw` / `html` / `svg` are the buffer itself; `png` / `pdf` are
 * rendered by the shared artifact exporter (`lib/artifacts/export`) so a Canvas
 * chart or diagram saves exactly the way the same content does from the dock.
 *
 * Saving goes through `saveExport`, not an `<a download>` anchor: the anchor
 * silently no-ops inside a mobile WebView, which is the same bug the artifact
 * side already fixed.
 */

import type {
  ArtifactExportFormat,
  ArtifactLanguage,
  ArtifactType,
  CanvasDocument,
} from "@/types/artifact/artifact"
import { getArtifactExportFormats } from "@/components/artifacts/runtime-adapters"
import { loggers } from "@cognia/logging"
import { canvasDocumentToArtifact } from "./artifact-projection"

/** Formats serialized straight from the Canvas buffer, with no rendering. */
const TEXT_FORMATS: ReadonlySet<ArtifactExportFormat> = new Set(["raw", "html", "svg"])

/** Every format a Canvas document can be exported as. */
const DOWNLOADABLE_FORMATS: ReadonlySet<ArtifactExportFormat> = new Set([
  "raw",
  "html",
  "svg",
  "png",
  "pdf",
])

const LANGUAGE_EXTENSIONS: Record<ArtifactLanguage, string> = {
  javascript: "js",
  typescript: "ts",
  python: "py",
  plaintext: "txt",
  html: "html",
  css: "css",
  json: "json",
  markdown: "md",
  jsx: "jsx",
  tsx: "tsx",
  sql: "sql",
  bash: "sh",
  yaml: "yaml",
  xml: "xml",
  svg: "svg",
  mermaid: "mmd",
  latex: "tex",
}

/** File extension for a document's language (defaults to `txt`). */
export function extensionForLanguage(language: ArtifactLanguage): string {
  return LANGUAGE_EXTENSIONS[language] ?? "txt"
}

/**
 * Formats a document can be exported as.
 *
 * `canvasDocumentToArtifact` answers a *preview* question, so it returns `null`
 * for a plain Python or JSON buffer — but "can this be previewed" and "can this
 * be exported" are different questions. A code document still exports the same
 * way a `code` artifact does in the dock (raw source, or a PDF laid out as
 * selectable text), and the two surfaces disagreeing about that was the whole
 * reason this function had a hand-written `["raw"]` fallback.
 */
export function getCanvasExportFormats(doc: CanvasDocument): ArtifactExportFormat[] {
  const previewArtifact = canvasDocumentToArtifact(doc)
  const type: ArtifactType = previewArtifact?.type ?? (doc.type === "text" ? "document" : "code")
  const formats = getArtifactExportFormats({ type })
  return formats.filter((format) => DOWNLOADABLE_FORMATS.has(format))
}

function sanitizeFilenameStem(title: string): string {
  const stem = title
    .trim()
    .replace(/[/\\?%*:|"<>]/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
  return stem || "canvas-document"
}

/** The filename a given export would produce (pure — used by the UI + tests). */
export function canvasExportFilename(doc: CanvasDocument, format: ArtifactExportFormat): string {
  const ext =
    format === "html" ? "html" : format === "svg" ? "svg" : extensionForLanguage(doc.language)
  return `${sanitizeFilenameStem(doc.title)}.${ext}`
}

function mimeForFormat(format: ArtifactExportFormat): string {
  if (format === "html") return "text/html"
  if (format === "svg") return "image/svg+xml"
  return "text/plain"
}

export interface CanvasExportPayload {
  filename: string
  content: string
  mime: string
}

/** Pure serialization of an export request (no DOM side effects). */
export function buildCanvasExportPayload(
  doc: CanvasDocument,
  format: ArtifactExportFormat
): CanvasExportPayload {
  return {
    filename: canvasExportFilename(doc, format),
    content: doc.content,
    mime: mimeForFormat(format),
  }
}

/**
 * Serialize a Canvas document to a file. Returns the filename written, or
 * `null` when the format is unsupported, the render failed, or the user
 * cancelled the save dialog.
 *
 * `png` / `pdf` project the document onto a synthetic artifact and hand it to
 * the shared exporter — the same code path the dock uses, so a Canvas mermaid
 * document and a mermaid artifact produce the same image.
 */
export async function exportCanvasDocument(
  doc: CanvasDocument,
  format: ArtifactExportFormat
): Promise<string | null> {
  if (!DOWNLOADABLE_FORMATS.has(format)) {
    loggers.canvas.warn("canvas export: unsupported format ignored", {
      documentId: doc.id,
      format,
    })
    return null
  }

  if (!TEXT_FORMATS.has(format)) {
    const artifact = canvasDocumentToArtifact(doc)
    if (!artifact) {
      loggers.canvas.warn("canvas export: document has no visual projection", {
        documentId: doc.id,
        format,
      })
      return null
    }
    try {
      const { exportArtifact, artifactExportFilename } = await import("@/lib/artifacts/export")
      const outcome = await exportArtifact(artifact, format)
      if (outcome.kind !== "saved") return null
      return artifactExportFilename(artifact, format)
    } catch (err) {
      loggers.canvas.warn("canvas export: render failed", {
        documentId: doc.id,
        format,
        error: err instanceof Error ? err.message : String(err),
      })
      return null
    }
  }

  const payload = buildCanvasExportPayload(doc, format)
  // Imported at call time: `save-export` reaches the Tauri / Capacitor
  // platform layer, which drags a large graph into any module that touches it —
  // this file's own tests run in the light `node` jest project.
  const { saveExport } = await import("@/lib/files/save-export")
  const outcome = await saveExport({
    filename: payload.filename,
    data: payload.content,
    mimeType: payload.mime,
  })
  if (outcome.kind === "error") {
    loggers.canvas.warn("canvas export: save failed", {
      documentId: doc.id,
      format,
      error: outcome.message,
    })
    return null
  }
  if (outcome.kind !== "saved") return null
  return payload.filename
}

/** Copy the document buffer to the clipboard. Returns whether it succeeded. */
export async function copyCanvasDocumentToClipboard(doc: CanvasDocument): Promise<boolean> {
  const clipboard = globalThis.navigator?.clipboard
  if (!clipboard?.writeText) return false
  try {
    await clipboard.writeText(doc.content)
    return true
  } catch (err) {
    loggers.canvas.warn("canvas export: clipboard copy failed", {
      documentId: doc.id,
      error: err instanceof Error ? err.message : String(err),
    })
    return false
  }
}
