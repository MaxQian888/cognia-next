/**
 * Staging layer for twin source intake — extract WITHOUT committing.
 *
 * Every add-source path (file / URL / paste / git repo / Lark doc) runs its
 * extraction here and returns `StagedSource[]` for the UI to preview; nothing
 * touches Dexie until the user confirms and `commitStagedSources` writes the
 * rows as `status:"pending"` twin sources. This is the seam that gives the
 * add-source flow its preview/confirm step.
 *
 * The extraction logic is lifted verbatim from the retired
 * `twin-source-uploader.tsx` `ingestFile` path: binary formats go through
 * `@cognia/document`'s `processDocumentAsync`, JSON chat exports auto-detect
 * their importer, mbox/eml/git fan out to many staged items, and failures
 * come back as structured `IngestError` codes localized against
 * `twin.sourceUploader.errors.*`.
 */

import { registerTwinSource, sourceFingerprint } from "./source-registration"
import {
  parseMbox,
  parseEml,
  parseSlackExport,
  parseChatgptExport,
  isChatgptExportShape,
  parseClaudeExport,
  isClaudeExportShape,
  parseGeminiExport,
  isGeminiExportShape,
  parseLarkExport,
  isLarkExportShape,
  parseDingtalkExport,
  isDingtalkTextShape,
  isDingtalkJsonShape,
  parseWechatExport,
  isWechatExportShape,
  parseGitRepo,
} from "@/lib/twin/importers"
import { BINARY_TWIN_FORMATS, detectSourceFormat } from "@/lib/twin/ingest"
import { fetchUrlAsRawSource } from "@/lib/twin/ingest/url-fetcher"
import {
  fetchLarkDocAsRawSource,
  LarkIngestError,
  type FetchLarkDocOptions,
  type LarkIngestErrorCode,
} from "@/lib/twin/ingest/lark-doc-fetcher"
import { parseLarkDocUrl } from "@/lib/twin/ingest/lark-url"
import { safeHostname } from "@/lib/web/reader/types"
import type { RawSource } from "@/lib/twin/ingest"
import type { TwinSourceFormat, TwinSourceKind } from "@/types/twin"

// ---------------------------------------------------------------------------
// Error envelope
// ---------------------------------------------------------------------------

export type IngestErrorCode =
  | "unknownFileType"
  | "noTextExtracted"
  | "parseFailed"
  | "parseFailedFallback"
  | "formatUnsupported"
  | "fileEmpty"
  | "shapeNoMessages"
  | "importParseFailed"
  | "importParseFailedFallback"
  | "dingTalkNoMessages"
  | "dingTalkParseFailed"
  | "dingTalkParseFailedFallback"
  | "noMessagesParsed"
  | "noCommitsFound"
  | "gitWalkFailed"
  | "pasteContentRequired"
  | "urlEmpty"
  | "urlInvalid"
  | "urlNoText"
  | "urlFetchFailed"
  | LarkIngestErrorCode

/**
 * Structured extraction error — translated at the React boundary with
 * `tErr(code, params)` so this layer stays free of `useTranslations`.
 */
export interface IngestError {
  code: IngestErrorCode
  params?: Record<string, string | number>
}

// ---------------------------------------------------------------------------
// Staged source model
// ---------------------------------------------------------------------------

export type StagedSourceOrigin = "file" | "url" | "paste" | "git" | "lark"

/** An extracted-but-uncommitted twin source, held in UI state for preview. */
export interface StagedSource {
  kind: TwinSourceKind
  format: TwinSourceFormat
  title: string
  text: string
  bytes: number
  tags?: string[]
  speakers?: string[]
  origin: StagedSourceOrigin
}

export interface StageResult {
  staged: StagedSource[]
  error?: IngestError
}

const fail = (code: IngestErrorCode, params?: Record<string, string | number>): StageResult => ({
  staged: [],
  error: { code, ...(params ? { params } : {}) },
})

// ---------------------------------------------------------------------------
// Shared helpers (lifted from twin-source-uploader.tsx)
// ---------------------------------------------------------------------------

const TEXTUAL_FORMATS: ReadonlySet<TwinSourceFormat> = new Set<TwinSourceFormat>([
  "markdown",
  "csv",
  "html",
  "rtf",
  "code",
  "mbox",
  "eml",
  "chatgpt-export",
  "claude-export",
  "gemini-export",
  "slack-export",
  "lark-export",
  "dingtalk-export",
  "wechat-export",
])

export function inferKind(format: TwinSourceFormat): TwinSourceKind {
  if (format === "code" || format === "git-repo") return "code"
  if (format === "mbox" || format === "eml") return "email"
  if (format.endsWith("-export")) return "chat"
  return "document"
}

/**
 * Heuristic: detect Slack-export JSON by looking for the canonical
 * `"type":"message"` token or `"messages":` envelope key near the top of
 * the document. Cheap regex avoids parsing twice.
 */
function isSlackShape(jsonText: string): boolean {
  const head = jsonText.slice(0, 4000)
  if (/"type"\s*:\s*"message"/.test(head)) return true
  if (/"messages"\s*:/.test(head) && /"text"\s*:/.test(head)) return true
  return false
}

export type ChatJsonImporterKey =
  | "chatgpt-export"
  | "claude-export"
  | "gemini-export"
  | "slack-export"
  | "lark-export"
  | "wechat-export"
  | "dingtalk-export"

/**
 * Detect which chat-export importer a parsed JSON value matches. The order
 * matters — more specific shapes (ChatGPT mapping tree, Claude
 * `chat_messages`) are checked before generic `messages` shapes.
 */
export function detectChatJsonImporter(
  parsed: unknown,
  raw: string
): ChatJsonImporterKey | undefined {
  if (isChatgptExportShape(parsed)) return "chatgpt-export"
  if (isClaudeExportShape(parsed)) return "claude-export"
  if (isGeminiExportShape(parsed)) return "gemini-export"
  if (isSlackShape(raw)) return "slack-export"
  if (isLarkExportShape(parsed)) return "lark-export"
  if (isWechatExportShape(parsed)) return "wechat-export"
  if (isDingtalkJsonShape(parsed)) return "dingtalk-export"
  return undefined
}

function runChatJsonImporter(
  key: ChatJsonImporterKey,
  text: string,
  twinId: string,
  source: string
): RawSource[] {
  const opts = { twinId, source }
  switch (key) {
    case "chatgpt-export":
      return parseChatgptExport(text, opts)
    case "claude-export":
      return parseClaudeExport(text, opts)
    case "gemini-export":
      return parseGeminiExport(text, opts)
    case "slack-export":
      return parseSlackExport(text, opts)
    case "lark-export":
      return parseLarkExport(text, opts)
    case "wechat-export":
      return parseWechatExport(text, opts)
    case "dingtalk-export":
      return parseDingtalkExport(text, opts)
  }
}

/**
 * Importer-produced participant names, or undefined when absent/empty.
 * Persisted on the source row so ingest can seed the redaction `nameHints`
 * pass — without this the names leak verbatim to the cloud embedder.
 */
function speakersOf(raw: RawSource): string[] | undefined {
  const speakers = raw.baseMetadata?.speakers
  return speakers && speakers.length > 0 ? speakers : undefined
}

function stagedFromRaws(
  raws: RawSource[],
  kind: TwinSourceKind,
  tags: string[],
  origin: StagedSourceOrigin
): StagedSource[] {
  return raws.map((raw) => ({
    kind,
    format: "markdown" as TwinSourceFormat, // importers emit pre-formatted markdown bodies
    title: raw.filename,
    text: raw.text ?? "",
    bytes: (raw.text ?? "").length,
    tags,
    speakers: speakersOf(raw),
    origin,
  }))
}

async function readFileAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result
      resolve(typeof result === "string" ? result : "")
    }
    reader.onerror = () => reject(reader.error ?? new Error("FileReader failed"))
    reader.readAsText(file)
  })
}

async function readFileAsArrayBuffer(file: File): Promise<ArrayBuffer> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result
      resolve(result instanceof ArrayBuffer ? result : new ArrayBuffer(0))
    }
    reader.onerror = () => reject(reader.error ?? new Error("FileReader failed"))
    reader.readAsArrayBuffer(file)
  })
}

// ---------------------------------------------------------------------------
// Stage: file
// ---------------------------------------------------------------------------

/**
 * Extract one picked file into staged sources. Chat-export JSON fans out per
 * conversation; mbox/eml fan out per message; binary formats keep only the
 * extracted text. `twinId` is needed because the importer layer stamps it
 * into its RawSource envelopes.
 */
export async function stageFile(file: File, twinId: string): Promise<StageResult> {
  const detected = detectSourceFormat(file.name)
  if (!detected) return fail("unknownFileType")

  if (BINARY_TWIN_FORMATS.has(detected)) {
    try {
      const buffer = await readFileAsArrayBuffer(file)
      const { processDocumentAsync } = await import("@cognia/document/document-processor")
      const tempId = `tws_pre_${twinId}_${Date.now().toString(36)}`
      const processed = await processDocumentAsync(tempId, file.name, buffer, {
        extractEmbeddable: true,
      })
      const text = processed.embeddableContent || processed.content
      if (!text.trim()) {
        return fail("noTextExtracted", { format: detected })
      }
      return {
        staged: [
          {
            kind: inferKind(detected),
            format: "markdown", // post-parse the body is structured text
            title: processed.metadata.title || file.name,
            text,
            bytes: buffer.byteLength,
            tags: [detected, "extracted"],
            origin: "file",
          },
        ],
      }
    } catch (err) {
      return err instanceof Error
        ? fail("parseFailed", { format: detected, reason: err.message })
        : fail("parseFailedFallback", { format: detected })
    }
  }

  if (!TEXTUAL_FORMATS.has(detected)) {
    return fail("formatUnsupported", { format: detected })
  }

  const text = await readFileAsText(file)
  if (!text.trim()) return fail("fileEmpty")

  // JSON files: detect chat-export shape and dispatch to the right importer.
  if (file.name.toLowerCase().endsWith(".json")) {
    let parsedJson: unknown = null
    try {
      parsedJson = JSON.parse(text)
    } catch {
      // Malformed JSON — drop to plain-text fallback below.
    }
    const importerKey = parsedJson !== null ? detectChatJsonImporter(parsedJson, text) : undefined
    if (importerKey) {
      const sourceLabel = file.name.replace(/\.json$/i, "")
      try {
        const raws = runChatJsonImporter(importerKey, text, twinId, sourceLabel)
        if (raws.length === 0) {
          return fail("shapeNoMessages", { importer: importerKey })
        }
        return { staged: stagedFromRaws(raws, "chat", [importerKey], "file") }
      } catch (err) {
        return err instanceof Error
          ? fail("importParseFailed", { importer: importerKey, reason: err.message })
          : fail("importParseFailedFallback", { importer: importerKey })
      }
    }
  }

  // Plain-text DingTalk export — `[YYYY-MM-DD HH:mm:ss] Name\nbody` lines.
  if (isDingtalkTextShape(text)) {
    try {
      const raws = parseDingtalkExport(text, {
        twinId,
        source: file.name.replace(/\.[^./]+$/i, ""),
      })
      if (raws.length === 0) return fail("dingTalkNoMessages")
      return { staged: stagedFromRaws(raws, "chat", ["dingtalk-export"], "file") }
    } catch (err) {
      return err instanceof Error
        ? fail("dingTalkParseFailed", { reason: err.message })
        : fail("dingTalkParseFailedFallback")
    }
  }

  // mbox / eml fan out into many staged sources via the importer layer.
  if (detected === "mbox" || detected === "eml") {
    const raws: RawSource[] =
      detected === "mbox"
        ? parseMbox(text, { twinId, source: file.name })
        : parseEml(text, { twinId, source: file.name })
    if (raws.length === 0) return fail("noMessagesParsed")
    return { staged: stagedFromRaws(raws, "email", [detected], "file") }
  }

  // Single-source path: one file → one staged source, format preserved.
  return {
    staged: [
      {
        kind: inferKind(detected),
        format: detected,
        title: file.name,
        text,
        bytes: text.length,
        origin: "file",
      },
    ],
  }
}

// ---------------------------------------------------------------------------
// Stage: URL
// ---------------------------------------------------------------------------

export interface StageUrlOptions {
  /** CORS-free fetch (`createProxyFetch()` on Tauri). Defaults to global fetch. */
  fetchImpl?: typeof fetch
  /** Enable the Jina Reader fallback for thin HTML extraction. */
  jinaFallback?: boolean
}

/**
 * Fetch a web page through the shared web reader and stage its extracted
 * readable text as a single markdown source.
 */
export async function stageUrl(url: string, opts: StageUrlOptions = {}): Promise<StageResult> {
  const trimmed = url.trim()
  if (!trimmed) return fail("urlEmpty")
  const host = safeHostname(trimmed)
  if (!host) return fail("urlInvalid")
  try {
    const fetched = await fetchUrlAsRawSource(trimmed, {
      ...(opts.fetchImpl ? { fetchImpl: opts.fetchImpl } : {}),
      jinaFallback: opts.jinaFallback ?? false,
    })
    const text = fetched.text.trim()
    if (!text) return fail("urlNoText")
    return {
      staged: [
        {
          kind: "document",
          // The reader already de-HTMLs the page, so persist markdown — NOT
          // the raw content-type — so ingest doesn't re-parse clean text.
          format: "markdown",
          title: fetched.title.trim() || host,
          text,
          bytes: text.length,
          tags: ["url", host],
          origin: "url",
        },
      ],
    }
  } catch (err) {
    return fail("urlFetchFailed", { reason: err instanceof Error ? err.message : String(err) })
  }
}

// ---------------------------------------------------------------------------
// Stage: Lark doc / wiki
// ---------------------------------------------------------------------------

/**
 * Fetch a Feishu/Lark doc or wiki node using a bound Lark account and stage
 * it as a single source. `LarkIngestError` codes surface directly as
 * `IngestError` codes (same `twin.sourceUploader.errors.*` namespace).
 */
export async function stageLarkDoc(
  urlOrToken: string,
  opts: FetchLarkDocOptions
): Promise<StageResult> {
  try {
    const fetched = await fetchLarkDocAsRawSource(urlOrToken, opts)
    const ref = parseLarkDocUrl(urlOrToken)
    const tags = ["lark", ref?.kind === "wiki" ? "lark-wiki" : "lark-doc"]
    if (ref?.host) tags.push(ref.host)
    return {
      staged: [
        {
          kind: "document",
          format: "markdown",
          title: fetched.title,
          text: fetched.text,
          bytes: fetched.text.length,
          tags,
          origin: "lark",
        },
      ],
    }
  } catch (err) {
    if (err instanceof LarkIngestError) {
      return fail(err.code, err.params)
    }
    return fail("larkNetwork", { reason: err instanceof Error ? err.message : String(err) })
  }
}

// ---------------------------------------------------------------------------
// Stage: git repo (Tauri only — caller owns the directory picker)
// ---------------------------------------------------------------------------

export interface StageGitRepoOptions {
  twinId: string
  repoPath: string
  maxCommits?: number
  author?: string
}

/** Walk a local git repo and stage one source per commit. */
export async function stageGitRepo(opts: StageGitRepoOptions): Promise<StageResult> {
  try {
    const raws = await parseGitRepo({
      twinId: opts.twinId,
      repoPath: opts.repoPath,
      maxCommits: opts.maxCommits && opts.maxCommits > 0 ? opts.maxCommits : 200,
      author: opts.author?.trim() || undefined,
    })
    if (raws.length === 0) return fail("noCommitsFound")
    // git-repo importer emits markdown-with-fenced-diff bodies; keep the tag
    // for downstream filtering but store as markdown so the existing
    // parse/chunk path handles it.
    return { staged: stagedFromRaws(raws, "code", ["git-repo"], "git") }
  } catch (err) {
    return fail("gitWalkFailed", { reason: err instanceof Error ? err.message : String(err) })
  }
}

// ---------------------------------------------------------------------------
// Stage: pasted text
// ---------------------------------------------------------------------------

export interface StagePasteInput {
  content: string
  format: TwinSourceFormat
  title?: string
}

/** Stage a pasted snippet as a single source of the chosen format. */
export function stagePaste(input: StagePasteInput): StageResult {
  const content = input.content
  if (!content.trim()) return fail("pasteContentRequired")
  return {
    staged: [
      {
        kind: inferKind(input.format),
        format: input.format,
        title: input.title?.trim() || `Pasted ${input.format} (${new Date().toLocaleString()})`,
        // `text` carries the body for the worker to load; the optional label
        // lives in `title` (storing the label in the body dropped the pasted
        // content so the worker embedded the label).
        text: content,
        bytes: content.length,
        origin: "paste",
      },
    ],
  }
}

// ---------------------------------------------------------------------------
// Commit
// ---------------------------------------------------------------------------

/**
 * Write confirmed staged sources to Dexie as `status:"pending"` rows.
 * Returns the number of rows created.
 */
export async function commitStagedSources(
  twinId: string,
  staged: readonly StagedSource[]
): Promise<number> {
  let count = 0
  for (const item of staged) {
    const fingerprint = await sourceFingerprint(item.text)
    const result = await registerTwinSource({
      twinId,
      kind: item.kind,
      format: item.format,
      source: item.text,
      title: item.title,
      bytes: item.bytes,
      fingerprint,
      redacted: false,
      status: "pending",
      ...(item.tags && item.tags.length > 0 ? { tags: item.tags } : {}),
      ...(item.speakers && item.speakers.length > 0 ? { speakers: item.speakers } : {}),
    })
    if (result.created || result.revived) count += 1
  }
  return count
}
