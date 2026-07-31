/**
 * Canvas document export.
 *
 * Reuses the Artifacts export contract (`getArtifactExportFormats`, via the
 * Canvas→Artifact projector) to decide which file formats a document can be
 * saved as, then serializes the buffer to a download. Formats are intentionally
 * limited to what the runtime adapters declare (raw / html / svg) — html and
 * svg documents are already standalone files, so no renderer is needed.
 */

import type {
  ArtifactExportFormat,
  ArtifactLanguage,
  CanvasDocument,
} from "@/types/artifact/artifact"
import { getArtifactExportFormats } from "@/components/artifacts/runtime-adapters"
import { loggers } from "@cognia/logging"
import { canvasDocumentToArtifact } from "./artifact-projection"

/** Downloadable file formats we know how to serialize from a Canvas buffer. */
const DOWNLOADABLE_FORMATS: ReadonlySet<ArtifactExportFormat> = new Set(["raw", "html", "svg"])

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
 * Formats a document can be exported as. Non-previewable code documents still
 * export their raw source; previewable ones defer to the runtime adapter table.
 */
export function getCanvasExportFormats(doc: CanvasDocument): ArtifactExportFormat[] {
  const artifact = canvasDocumentToArtifact(doc)
  const formats = artifact ? getArtifactExportFormats(artifact) : ["raw" as ArtifactExportFormat]
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

function triggerBrowserDownload(payload: CanvasExportPayload): void {
  const doc = globalThis.document
  /* istanbul ignore if -- SSR / non-DOM guard, not reachable under jsdom */
  if (!doc) return
  const blob = new Blob([payload.content], { type: payload.mime })
  const canObjectUrl = typeof URL.createObjectURL === "function"
  const url = canObjectUrl
    ? URL.createObjectURL(blob)
    : `data:${payload.mime};charset=utf-8,${encodeURIComponent(payload.content)}`
  const anchor = doc.createElement("a")
  anchor.href = url
  anchor.download = payload.filename
  anchor.rel = "noopener"
  doc.body.appendChild(anchor)
  anchor.click()
  anchor.remove()
  if (canObjectUrl) URL.revokeObjectURL(url)
}

/**
 * Serialize a Canvas document to a file download. Returns the filename written,
 * or `null` when the format is unsupported / DOM is unavailable.
 */
export function exportCanvasDocument(
  doc: CanvasDocument,
  format: ArtifactExportFormat
): string | null {
  if (!DOWNLOADABLE_FORMATS.has(format)) {
    loggers.canvas.warn("canvas export: unsupported format ignored", {
      documentId: doc.id,
      format,
    })
    return null
  }
  const payload = buildCanvasExportPayload(doc, format)
  triggerBrowserDownload(payload)
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
