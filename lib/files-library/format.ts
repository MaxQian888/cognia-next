/**
 * File format of a Files entry (ADR-0223): what the Type column says and what
 * the "Type" filter matches. Finer than the sidebar's kind groups — a
 * Files-owned upload can be a PDF, a spreadsheet or an image — and coarser than
 * an extension, so the filter stays a short list.
 *
 * Uploads are classified by filename through the shared
 * `resolveFileTypeIcon` taxonomy (the same answer the icon gives), falling back
 * to the media type. Artifacts and canvas documents have no filename; their
 * own type and language decide.
 */

import { resolveFileTypeIcon, type FileTypeIconKind } from "@/lib/files/file-type-icon"

import type { FilesEntry } from "./types"

export const FILES_FORMATS = [
  "document",
  "code",
  "data",
  "diagram",
  "image",
  "video",
  "audio",
  "archive",
  "other",
] as const
export type FilesFormat = (typeof FILES_FORMATS)[number]

const FORMAT_OF_ICON_KIND: Record<FileTypeIconKind, FilesFormat> = {
  folder: "other",
  code: "code",
  javascript: "code",
  typescript: "code",
  react: "code",
  vue: "code",
  svelte: "code",
  python: "code",
  rust: "code",
  go: "code",
  java: "code",
  ruby: "code",
  php: "code",
  shell: "code",
  html: "code",
  css: "code",
  json: "data",
  yaml: "data",
  toml: "data",
  xml: "data",
  database: "data",
  spreadsheet: "data",
  config: "data",
  markdown: "document",
  text: "document",
  pdf: "document",
  document: "document",
  presentation: "document",
  notebook: "document",
  image: "image",
  video: "video",
  audio: "audio",
  archive: "archive",
  font: "other",
  lock: "other",
  key: "other",
  git: "other",
  docker: "other",
  package: "archive",
  binary: "other",
  file: "other",
}

/** Every icon kind maps somewhere — exported so a test can prove the table total. */
export function formatOfIconKind(kind: FileTypeIconKind): FilesFormat {
  return FORMAT_OF_ICON_KIND[kind]
}

function formatOfMediaType(mediaType: string | undefined): FilesFormat {
  const type = mediaType?.toLowerCase() ?? ""
  if (type.startsWith("image/")) return "image"
  if (type.startsWith("video/")) return "video"
  if (type.startsWith("audio/")) return "audio"
  if (type.startsWith("text/")) return "document"
  if (type === "application/pdf") return "document"
  if (type === "application/json" || type.endsWith("+json") || type.endsWith("/csv")) return "data"
  if (type === "application/zip" || type.includes("compressed") || type.includes("tar")) {
    return "archive"
  }
  return "other"
}

const DIAGRAM_ARTIFACT_TYPES = new Set(["svg", "mermaid", "chart", "math"])
const DOCUMENT_LANGUAGES = new Set(["markdown", "plaintext", "latex"])
const DATA_LANGUAGES = new Set(["json", "yaml", "xml"])

export function filesFormatOf(
  entry: Pick<FilesEntry, "kind" | "title" | "sourceTitle" | "mediaType" | "subtype" | "language">
): FilesFormat {
  switch (entry.kind) {
    case "image":
      return "image"
    case "artifact": {
      if (entry.subtype === "document" || entry.subtype === "jupyter") return "document"
      if (entry.subtype && DIAGRAM_ARTIFACT_TYPES.has(entry.subtype)) return "diagram"
      if (entry.language && DATA_LANGUAGES.has(entry.language)) return "data"
      return "code"
    }
    case "canvas": {
      if (entry.subtype === "text") return "document"
      if (entry.language && DOCUMENT_LANGUAGES.has(entry.language)) return "document"
      if (entry.language && DATA_LANGUAGES.has(entry.language)) return "data"
      return "code"
    }
    case "session-upload":
    case "upload": {
      const byName = formatOfIconKind(resolveFileTypeIcon(entry.sourceTitle || entry.title).kind)
      return byName !== "other" ? byName : formatOfMediaType(entry.mediaType)
    }
  }
}
