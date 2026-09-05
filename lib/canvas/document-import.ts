/**
 * Turn a file the user picked into a Canvas document.
 *
 * Reuses `@cognia/document`, which already folds eleven formats into one
 * `ProcessedDocument` and is what chat attachments, connector inbound media and
 * the knowledge base all go through. Canvas asks it for the same thing they do
 * and then answers two Canvas-specific questions the package does not:
 *
 *  - **Which editor language does this become?** A `.py` file must open as
 *    Python, not as "code".
 *  - **Was anything lost getting here?** A text or code file arrives byte for
 *    byte. A PDF, Office file, RTF, EPUB or deck does not. It becomes editable
 *    Markdown, and layout, images and embedded objects do not survive. That is
 *    a fact the user has to be told before they start editing, so it is part of
 *    the result rather than a log line.
 */

import {
  detectDocumentTypeFromFilename,
  isBinaryDocumentType,
} from "@cognia/document/support-matrix"
import type { DocumentType, ParseDiagnostic } from "@cognia/document/types"
import type { ArtifactLanguage } from "@/types"

/** Why an imported document may not match the file it came from. */
export type CanvasImportWarningCode =
  /** The source format has no plain-text form, so the body is a rendering. */
  | "converted-to-markdown"
  /** The parser reported a problem with part of the file. */
  | "parse-diagnostic"
  /** The file produced no readable text at all. */
  | "empty"

export interface CanvasImportWarning {
  code: CanvasImportWarningCode
  message: string
}

export interface CanvasImportResult {
  title: string
  content: string
  language: ArtifactLanguage
  type: "code" | "text"
  /** The detected source format, kept for provenance on the document. */
  sourceFormat: DocumentType
  sourceFilename: string
  warnings: CanvasImportWarning[]
}

/**
 * Extension to editor language. Deliberately narrower than the parser's own
 * extension table: this maps onto `ArtifactLanguage`, which is the set Monaco,
 * CodeMirror and the preview projector all agree on. Anything outside it opens
 * as plain text rather than being highlighted as the wrong language.
 */
const EXTENSION_LANGUAGE: Record<string, ArtifactLanguage> = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  py: "python",
  html: "html",
  htm: "html",
  css: "css",
  scss: "css",
  less: "css",
  json: "json",
  md: "markdown",
  markdown: "markdown",
  mdx: "markdown",
  sql: "sql",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  yaml: "yaml",
  yml: "yaml",
  svg: "svg",
  tex: "latex",
  mmd: "mermaid",
}

/** Formats whose text form is Markdown once the parser is done with them. */
const MARKDOWN_RESULT_TYPES: ReadonlySet<DocumentType> = new Set([
  "pdf",
  "word",
  "excel",
  "csv",
  "html",
  "rtf",
  "epub",
  "presentation",
])

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf(".")
  return dot === -1 ? "" : filename.slice(dot + 1).toLowerCase()
}

/** Strip the extension so the document title reads like a document, not a file. */
export function titleFromFilename(filename: string): string {
  const base = filename.split(/[/\\]/).pop() ?? filename
  const dot = base.lastIndexOf(".")
  const stem = dot > 0 ? base.slice(0, dot) : base
  return stem.trim() || base
}

/**
 * The editor language and document type an import should open as.
 *
 * A converted binary always lands as Markdown, whatever it started as. The body
 * is Markdown by then, and opening a PDF's text as `pdf` would ask the editor
 * for a grammar that does not exist.
 */
export function resolveImportLanguage(
  filename: string,
  documentType: DocumentType
): { language: ArtifactLanguage; type: "code" | "text" } {
  if (MARKDOWN_RESULT_TYPES.has(documentType)) {
    return { language: "markdown", type: "text" }
  }
  const language = EXTENSION_LANGUAGE[extensionOf(filename)]
  if (!language) {
    return { language: "markdown", type: "text" }
  }
  const textual = language === "markdown" || language === "latex"
  return { language, type: textual ? "text" : "code" }
}

/**
 * Warnings for a completed parse, in the order they matter to someone about to
 * edit the result.
 */
export function buildImportWarnings(input: {
  documentType: DocumentType
  content: string
  diagnostics?: ParseDiagnostic[]
}): CanvasImportWarning[] {
  const warnings: CanvasImportWarning[] = []

  if (isBinaryDocumentType(input.documentType)) {
    warnings.push({ code: "converted-to-markdown", message: input.documentType })
  }
  if (input.content.trim().length === 0) {
    warnings.push({ code: "empty", message: input.documentType })
  }
  for (const diagnostic of input.diagnostics ?? []) {
    // `info` diagnostics describe what the parser did, not what it failed at.
    if (diagnostic.severity === "info") continue
    warnings.push({ code: "parse-diagnostic", message: diagnostic.message })
  }
  return warnings
}

/** Injected so tests do not have to load the parser bundle. */
export interface CanvasImportDeps {
  processDocument: (
    id: string,
    filename: string,
    data: ArrayBuffer | string
  ) => Promise<{
    type: DocumentType
    content: string
    parseDiagnostics?: ParseDiagnostic[]
    metadata?: { title?: string }
  }>
}

async function defaultDeps(): Promise<CanvasImportDeps> {
  // Imported lazily and by submodule, not through the `@cognia/document`
  // barrel: the PDF and Office parsers are megabytes, and a user who never
  // imports a file should never download them.
  const { processDocumentAsync } = await import("@cognia/document/document-processor")
  return { processDocument: processDocumentAsync }
}

/**
 * Read one file into the shape `createCanvasDocument` takes.
 *
 * Text and code arrive verbatim, which is the whole point of importing them:
 * the file IS the document. Everything else is converted, and says so.
 */
export async function importCanvasDocument(
  file: File,
  deps?: CanvasImportDeps
): Promise<CanvasImportResult> {
  const resolved = deps ?? (await defaultDeps())
  const detectedType = detectDocumentTypeFromFilename(file.name)

  // A text or code file is read as text so its bytes survive exactly. Routing
  // it through the binary path would normalise whitespace and line endings.
  const payload: ArrayBuffer | string = isBinaryDocumentType(detectedType)
    ? await file.arrayBuffer()
    : await file.text()

  const processed = await resolved.processDocument(`canvas-import:${file.name}`, file.name, payload)
  const { language, type } = resolveImportLanguage(file.name, processed.type)

  return {
    title: processed.metadata?.title?.trim() || titleFromFilename(file.name),
    content: processed.content,
    language,
    type,
    sourceFormat: processed.type,
    sourceFilename: file.name,
    warnings: buildImportWarnings({
      documentType: processed.type,
      content: processed.content,
      diagnostics: processed.parseDiagnostics,
    }),
  }
}
