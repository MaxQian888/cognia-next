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
  "pptx",
  "odt",
  "odp",
  "html",
  "csv",
  "epub",
  "rtf",
  "code",
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
  docx: "docx",
  doc: "docx",
  pptx: "pptx",
  ppt: "pptx",
  odt: "odt",
  odp: "odp",
  html: "html",
  htm: "html",
  csv: "csv",
  tsv: "csv",
  epub: "epub",
  rtf: "rtf",
  mbox: "mbox",
  eml: "eml",
  ts: "code",
  tsx: "code",
  js: "code",
  jsx: "code",
  py: "code",
  rb: "code",
  rs: "code",
  go: "code",
  java: "code",
  cpp: "code",
  c: "code",
  h: "code",
  swift: "code",
  kt: "code",
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
