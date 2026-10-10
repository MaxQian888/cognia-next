/**
 * The editable text behind a Files entry (ADR-0223): a canvas document's own
 * content, or an artifact's content read as a document. Duplicate and "Save as
 * template" both start from it, so an artifact copies and templates the same
 * way: prose (`document`) becomes Markdown text, anything else code.
 */

import type { ArtifactLanguage } from "@/types/artifact/artifact"

import type { FilesEntry } from "./types"

export interface FilesDocumentDraft {
  content: string
  language: ArtifactLanguage
  type: "code" | "text"
}

/** The slice of the artifact store a draft reads. */
export interface FilesDocumentSources {
  canvasDocuments: Record<
    string,
    { content: string; language: ArtifactLanguage; type: "code" | "text" } | undefined
  >
  artifacts: Record<
    string,
    { content: string; language?: ArtifactLanguage; type: string } | undefined
  >
}

/** Entries that carry editable text (and so can be duplicated as or saved as a document). */
export function hasDocumentDraft(entry: Pick<FilesEntry, "kind">): boolean {
  return entry.kind === "canvas" || entry.kind === "artifact"
}

/** The entry's text, or null when it has none or its source is gone. */
export function documentDraftOf(
  entry: Pick<FilesEntry, "kind" | "sourceId">,
  sources: FilesDocumentSources
): FilesDocumentDraft | null {
  if (entry.kind === "canvas") {
    const doc = sources.canvasDocuments[entry.sourceId]
    return doc ? { content: doc.content, language: doc.language, type: doc.type } : null
  }
  if (entry.kind === "artifact") {
    const artifact = sources.artifacts[entry.sourceId]
    if (!artifact) return null
    const prose = artifact.type === "document"
    return {
      content: artifact.content,
      language: artifact.language ?? (prose ? "markdown" : "plaintext"),
      type: prose ? "text" : "code",
    }
  }
  return null
}
