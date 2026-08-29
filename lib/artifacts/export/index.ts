"use client"

/**
 * One entry point for every artifact export format.
 *
 * Before this there were three download paths that disagreed:
 * `use-artifact-panel.handleDownload` (format-aware), `handleDownloadAs`
 * (docx/pdf through the document writer) and `artifact-part.handleDownload`
 * (a `text/plain` blob with `.${artifact.type}` for an extension — so a chart
 * downloaded as `chart.chart`). They now all come through here.
 *
 * `raw` / `html` / `svg` are the source text. `png` / `pdf` render, and are
 * lazily imported so `html2canvas-pro` and `jspdf` never enter the bundle for
 * a user who only ever copies source.
 */

import { getArtifactExportFormats } from "@/components/artifacts/runtime-adapters"
import { getArtifactExtension } from "@/lib/artifacts/constants"
import { saveExport, type SaveExportOutcome } from "@/lib/files/save-export"
import type { Artifact, ArtifactExportFormat } from "@/types"

export {
  ArtifactNotRasterisableError,
  ArtifactPreviewNotMountedError,
  ArtifactTooLargeToRasteriseError,
} from "./raster"

/** The artifact's adapter does not offer the requested format. */
export class UnsupportedArtifactExportError extends Error {
  constructor(type: string, format: ArtifactExportFormat) {
    super(`artifact type ${type} cannot be exported as ${format}`)
    this.name = "UnsupportedArtifactExportError"
  }
}

const MIME_BY_FORMAT: Record<ArtifactExportFormat, string> = {
  raw: "text/plain;charset=utf-8",
  html: "text/html;charset=utf-8",
  svg: "image/svg+xml;charset=utf-8",
  png: "image/png",
  pdf: "application/pdf",
}

/** Strip characters a filename cannot carry, keeping the title readable. */
function safeBase(title: string): string {
  return title.replace(/[\\/:*?"<>|]+/g, " ").trim() || "artifact"
}

export function artifactExportFilename(
  artifact: Pick<Artifact, "type" | "title" | "language">,
  format: ArtifactExportFormat
): string {
  const extension =
    format === "raw" ? getArtifactExtension(artifact.type, artifact.language) : format
  return `${safeBase(artifact.title)}.${extension}`
}

export interface RenderedArtifactExport {
  data: string | Blob
  mimeType: string
  filename: string
}

/** Produce the bytes for one export format without saving them. */
export async function renderArtifactExport(
  artifact: Pick<Artifact, "id" | "type" | "title" | "content" | "language" | "metadata">,
  format: ArtifactExportFormat
): Promise<RenderedArtifactExport> {
  if (!getArtifactExportFormats(artifact).includes(format)) {
    throw new UnsupportedArtifactExportError(artifact.type, format)
  }
  const filename = artifactExportFilename(artifact, format)
  const mimeType = MIME_BY_FORMAT[format]

  if (format === "png") {
    const { renderArtifactToPngBlob } = await import("./raster")
    return { data: await renderArtifactToPngBlob(artifact), mimeType, filename }
  }
  if (format === "pdf") {
    const { renderArtifactToPdfBlob } = await import("./pdf")
    return { data: await renderArtifactToPdfBlob(artifact), mimeType, filename }
  }
  // raw / html / svg are all the source text; only the extension and the mime
  // differ, and the adapter table already decided which of them are on offer.
  return { data: artifact.content, mimeType, filename }
}

/**
 * Render and save. Returns the saver's outcome so the caller can report *where*
 * the file went (or that the user cancelled), which is the whole reason
 * `saveExport` exists.
 */
export async function exportArtifact(
  artifact: Pick<Artifact, "id" | "type" | "title" | "content" | "language" | "metadata">,
  format: ArtifactExportFormat
): Promise<SaveExportOutcome> {
  const rendered = await renderArtifactExport(artifact, format)
  return saveExport({
    filename: rendered.filename,
    data: rendered.data,
    mimeType: rendered.mimeType,
  })
}
