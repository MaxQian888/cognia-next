/**
 * Source dispatch — picks a parser/importer family by `kind`+`format`.
 *
 * The ingest pipeline (`job-runner.ts`) calls `dispatchSource` once per
 * uploaded artefact to know how to parse it. Document-family formats route
 * to `lib/document/document-processor.ts` (Cognia's unified parser);
 * email/chat/code formats route to `lib/twin/importers/*` (cognia-next's
 * own thin wrappers that produce the same `ParsedSource` shape).
 *
 * Routing is data-driven — tests (and Phase 7's source-uploader UI) can
 * call `detectSourceFormat()` against a filename to pick a sensible
 * default before the user confirms.
 */

import type { TwinSourceFormat, TwinSourceKind } from "@/types/twin"

/** Result of dispatching a source — consumed by `parse.ts`. */
export interface DispatchResult {
  kind: TwinSourceKind
  format: TwinSourceFormat
  /** True if the format is handled by `lib/document/document-processor.ts`. */
  routesToDocumentProcessor: boolean
  /**
   * Importer module path used by `parse.ts` when
   * `routesToDocumentProcessor` is false. Examples:
   * `chat-export/slack`, `email/mbox`, `code-repo/git-repo`.
   */
  importerKey?: string
}

const DOCUMENT_FORMATS: ReadonlySet<TwinSourceFormat> = new Set<TwinSourceFormat>([
  "markdown",
  "pdf",
  "docx",
  "xlsx",
  "pptx",
  "odt",
  "odp",
  "html",
  "csv",
  "epub",
  "rtf",
  "code",
])

/**
 * Formats that must be fed to `parseSource` as an `ArrayBuffer` (binary
 * office/pdf/epub containers). The document processor decodes them; text
 * formats take the `raw.text` path instead. Single source of truth for the
 * uploader — it used to keep a duplicate set that drifted (Excel was missing).
 */
export const BINARY_TWIN_FORMATS: ReadonlySet<TwinSourceFormat> = new Set<TwinSourceFormat>([
  "pdf",
  "docx",
  "xlsx",
  "pptx",
  "odt",
  "odp",
  "epub",
])

const CHAT_IMPORTER_KEYS: Partial<Record<TwinSourceFormat, string>> = {
  "chatgpt-export": "chat-export/chatgpt",
  "claude-export": "chat-export/claude",
  "gemini-export": "chat-export/gemini",
  "slack-export": "chat-export/slack",
  "lark-export": "chat-export/lark",
  "dingtalk-export": "chat-export/dingtalk",
  "wechat-export": "chat-export/wechat",
}

const KIND_BY_FORMAT: Record<TwinSourceFormat, TwinSourceKind> = {
  markdown: "document",
  pdf: "document",
  docx: "document",
  xlsx: "document",
  pptx: "document",
  odt: "document",
  odp: "document",
  html: "document",
  csv: "document",
  epub: "document",
  rtf: "document",
  code: "code",
  "chatgpt-export": "chat",
  "claude-export": "chat",
  "gemini-export": "chat",
  "slack-export": "chat",
  "lark-export": "chat",
  "dingtalk-export": "chat",
  "wechat-export": "chat",
  mbox: "email",
  eml: "email",
  "git-repo": "code",
}

/**
 * Pure dispatch — given the user-confirmed `format`, return where the
 * pipeline should route. Wraps `KIND_BY_FORMAT` so callers don't have to
 * remember the kind/format mapping.
 */
export function dispatchSource(format: TwinSourceFormat): DispatchResult {
  const kind = KIND_BY_FORMAT[format]
  if (DOCUMENT_FORMATS.has(format)) {
    return { kind, format, routesToDocumentProcessor: true }
  }
  if (format === "mbox" || format === "eml") {
    return {
      kind,
      format,
      routesToDocumentProcessor: false,
      importerKey: format === "mbox" ? "email/mbox" : "email/eml",
    }
  }
  if (format === "git-repo") {
    return { kind, format, routesToDocumentProcessor: false, importerKey: "code-repo/git-repo" }
  }
  const importerKey = CHAT_IMPORTER_KEYS[format]
  if (importerKey) {
    return { kind, format, routesToDocumentProcessor: false, importerKey }
  }
  throw new Error(`Unknown twin source format: ${format}`)
}

const EXTENSION_FORMAT: Record<string, TwinSourceFormat> = {
  md: "markdown",
  markdown: "markdown",
  txt: "markdown",
  pdf: "pdf",
  // Word — legacy .doc + macro-enabled .docm both route to the docx parser
  // family (mammoth emits a "convert to .docx" diagnostic for very old .doc).
  docx: "docx",
  doc: "docx",
  docm: "docx",
  // Excel / spreadsheets — .xls/.xlsm parse via the xlsx library, .ods via the
  // ODF parser (both resolved inside processDocumentAsync by real extension).
  xlsx: "xlsx",
  xls: "xlsx",
  xlsm: "xlsx",
  ods: "xlsx",
  // Presentations — legacy .ppt is rejected with a "convert to .pptx"
  // diagnostic by the processor, but still classifies as pptx here.
  pptx: "pptx",
  ppt: "pptx",
  pptm: "pptx",
  odt: "odt",
  odp: "odp",
  html: "html",
  htm: "html",
  xhtml: "html",
  csv: "csv",
  tsv: "csv",
  epub: "epub",
  rtf: "rtf",
  mbox: "mbox",
  eml: "eml",
  // Code — mirrors the `code` extension set in
  // `packages/document/src/support-matrix.ts` so nothing the canonical parser
  // understands falls through to the unknown-file-type gate.
  ts: "code",
  tsx: "code",
  js: "code",
  jsx: "code",
  py: "code",
  rb: "code",
  rs: "code",
  go: "code",
  java: "code",
  kt: "code",
  cpp: "code",
  c: "code",
  h: "code",
  php: "code",
  scala: "code",
  r: "code",
  swift: "code",
  sh: "code",
  bash: "code",
  zsh: "code",
  ps1: "code",
  vue: "code",
  svelte: "code",
  sql: "code",
  css: "code",
  scss: "code",
  less: "code",
  xml: "code",
  yaml: "code",
  yml: "code",
  // Generic .json routes as markdown text; the uploader sniffs chat-export
  // shapes (ChatGPT/Claude/Slack/…) AFTER this coarse detection and rewrites
  // the format to the matching importer. Without this key .json files died
  // at the unknown-file-type gate and the JSON import branch was unreachable.
  json: "markdown",
}

/**
 * Heuristic format guess from a filename. Returns `undefined` if the
 * extension is unknown — the UI prompts the user to pick manually.
 */
export function detectSourceFormat(filename: string): TwinSourceFormat | undefined {
  const ext = filename.split(".").pop()?.toLowerCase()
  if (!ext) return undefined
  return EXTENSION_FORMAT[ext]
}

/** Public-facing list of formats the dispatcher can route. UI uses this. */
export function listSupportedFormats(): readonly TwinSourceFormat[] {
  return Object.keys(KIND_BY_FORMAT) as TwinSourceFormat[]
}

/**
 * Every filename extension `detectSourceFormat` recognises (no leading dot).
 * The source uploader derives its file-picker `accept` from this so the picker
 * and the detector never drift — adding an extension here automatically lets
 * users select that file type.
 */
export function listSupportedExtensions(): readonly string[] {
  return Object.keys(EXTENSION_FORMAT)
}
