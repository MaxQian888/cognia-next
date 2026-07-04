"use client"

/**
 * Source uploader. Two modes share one card:
 *
 *   1. **File picker** — accepts text AND binary files. Text formats land
 *      verbatim in Dexie; binary formats (PDF / DOCX / PPTX / EPUB / ODT /
 *      ODP) are parsed in the browser via
 *      `lib/document/document-processor:processDocumentAsync` and only
 *      their extracted text is stored. .mbox / .eml route through
 *      `lib/twin/importers/email/*` so a single mailbox produces many
 *      source rows in one click.
 *
 *   2. **From a URL** — fetches a web page / article via the shared web
 *      reader (`lib/twin/ingest/url-fetcher:fetchUrlAsRawSource`) and stores
 *      the extracted readable text as a single `markdown` source. CORS-free
 *      on Tauri (proxy fetch + Jina fallback); the browser uses the global
 *      fetch and shows a CORS caveat.
 *
 *   3. **Paste text** — the original Phase 7 path; useful for snippets or
 *      content that doesn't live in a file (slack message dumps, prose
 *      notes, etc.).
 */

import { useRef, useState, useSyncExternalStore } from "react"
import { useTranslations } from "next-intl"
import { Loader2Icon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { createTwinSource } from "@/lib/db/twin-sources"
import { isTauri } from "@/lib/tauri"
import { parseGitRepo } from "@/lib/twin/importers"
import {
  BINARY_TWIN_FORMATS,
  detectSourceFormat,
  listSupportedExtensions,
  listSupportedFormats,
} from "@/lib/twin/ingest"
import { fetchUrlAsRawSource } from "@/lib/twin/ingest/url-fetcher"
import { safeHostname } from "@/lib/web/reader/types"
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
} from "@/lib/twin/importers"
import type { RawSource } from "@/lib/twin/ingest"
import type { TwinSourceFormat, TwinSourceKind } from "@/types/twin"

const FORMATS: TwinSourceFormat[] = listSupportedFormats() as TwinSourceFormat[]

// `isTauri()` reads `window.__TAURI_INTERNALS__`. Use `useSyncExternalStore`
// so SSR returns `false` and the client reads the real value on first paint
// without triggering a cascading effect-driven re-render.
const subscribeTauri = (): (() => void) => () => {}
const getTauriSnapshot = (): boolean => isTauri()
const getServerTauriSnapshot = (): boolean => false

/**
 * Extensions accepted by the file picker. Derived from the ingest dispatcher's
 * extension table (`listSupportedExtensions`) so the picker never drifts from
 * what `detectSourceFormat` can actually route — text formats land verbatim,
 * binary formats (PDF / DOCX / XLSX / PPTX / EPUB / ODT / ODP) are parsed in
 * the browser and only their extracted text is stored.
 */
const FILE_PICKER_ACCEPT = listSupportedExtensions()
  .map((ext) => `.${ext}`)
  .join(",")

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

/**
 * Formats handled by `@cognia/document/document-processor:processDocumentAsync`.
 * Parsed in the browser; we persist the resulting text only. Sourced from the
 * ingest dispatcher (`BINARY_TWIN_FORMATS`) so this stays in lock-step with the
 * routing layer instead of maintaining a drift-prone duplicate.
 */
const BINARY_FORMATS: ReadonlySet<TwinSourceFormat> = BINARY_TWIN_FORMATS

function inferKind(format: TwinSourceFormat): TwinSourceKind {
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

type ChatJsonImporterKey =
  | "chatgpt-export"
  | "claude-export"
  | "gemini-export"
  | "slack-export"
  | "lark-export"
  | "wechat-export"
  | "dingtalk-export"

/**
 * Detect which chat-export importer a parsed JSON value matches. The
 * order matters — more specific shapes (ChatGPT mapping tree, Claude
 * `chat_messages`) are checked before generic `messages` shapes. Returns
 * `undefined` when no importer recognises the shape.
 */
function detectChatJsonImporter(parsed: unknown, raw: string): ChatJsonImporterKey | undefined {
  if (isChatgptExportShape(parsed)) return "chatgpt-export"
  if (isClaudeExportShape(parsed)) return "claude-export"
  if (isGeminiExportShape(parsed)) return "gemini-export"
  if (isSlackShape(raw)) return "slack-export"
  if (isLarkExportShape(parsed)) return "lark-export"
  if (isWechatExportShape(parsed)) return "wechat-export"
  if (isDingtalkJsonShape(parsed)) return "dingtalk-export"
  return undefined
}

const CHAT_IMPORTER_TAGS: Record<ChatJsonImporterKey, string> = {
  "chatgpt-export": "chatgpt-export",
  "claude-export": "claude-export",
  "gemini-export": "gemini-export",
  "slack-export": "slack-export",
  "lark-export": "lark-export",
  "wechat-export": "wechat-export",
  "dingtalk-export": "dingtalk-export",
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

async function sha256(text: string): Promise<string> {
  const enc = new TextEncoder()
  const bytes = enc.encode(text)
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
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

/**
 * Structured error code returned by {@link ingestFile} — translated at the
 * React boundary so the parsing layer stays free of `useTranslations`.
 * `params` are passed straight through to next-intl's interpolation engine.
 */
export interface IngestError {
  code:
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
    | "pasteContentRequired"
  params?: Record<string, string | number>
}

interface IngestedFromFile {
  /** Sources actually created (already written to Dexie). */
  sources: number
  /** Per-file diagnostic — used to render the post-batch summary. */
  perFile: Array<{ filename: string; sources: number; error?: IngestError }>
}

async function ingestFile(
  file: File,
  twinId: string
): Promise<{ sources: number; error?: IngestError }> {
  const detected = detectSourceFormat(file.name)
  if (!detected) {
    return { sources: 0, error: { code: "unknownFileType" } }
  }

  // Binary formats — parse in the browser via the ported document processor
  // and persist only the extracted text. The worker / scheduler stay
  // text-only.
  if (BINARY_FORMATS.has(detected)) {
    try {
      const buffer = await readFileAsArrayBuffer(file)
      const { processDocumentAsync } = await import("@cognia/document/document-processor")
      const tempId = `tws_pre_${twinId}_${Date.now().toString(36)}`
      const processed = await processDocumentAsync(tempId, file.name, buffer, {
        extractEmbeddable: true,
      })
      const text = processed.embeddableContent || processed.content
      if (!text.trim()) {
        return {
          sources: 0,
          error: { code: "noTextExtracted", params: { format: detected } },
        }
      }
      const fingerprint = await sha256(text)
      await createTwinSource({
        twinId,
        kind: inferKind(detected),
        format: "markdown", // post-parse the body is structured text
        source: text,
        title: processed.metadata.title || file.name,
        bytes: buffer.byteLength,
        fingerprint,
        redacted: false,
        status: "pending",
        tags: [detected, "extracted"],
      })
      return { sources: 1 }
    } catch (err) {
      return {
        sources: 0,
        error:
          err instanceof Error
            ? { code: "parseFailed", params: { format: detected, reason: err.message } }
            : { code: "parseFailedFallback", params: { format: detected } },
      }
    }
  }

  if (!TEXTUAL_FORMATS.has(detected)) {
    return {
      sources: 0,
      error: { code: "formatUnsupported", params: { format: detected } },
    }
  }

  const text = await readFileAsText(file)
  if (!text.trim()) {
    return { sources: 0, error: { code: "fileEmpty" } }
  }

  // JSON files: detect chat-export shape and dispatch to the right
  // importer. Order: ChatGPT (mapping tree) → Claude (chat_messages) →
  // Gemini (Takeout activity) → Slack (regex heuristic) → Lark → WeChat
  // → DingTalk-JSON. Falls through to plain-text ingest if no shape matches.
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
          return {
            sources: 0,
            error: { code: "shapeNoMessages", params: { importer: importerKey } },
          }
        }
        let count = 0
        for (const raw of raws) {
          const fingerprint = await sha256(raw.text ?? "")
          await createTwinSource({
            twinId,
            kind: "chat",
            format: "markdown",
            source: raw.text ?? "",
            title: raw.filename,
            bytes: (raw.text ?? "").length,
            fingerprint,
            redacted: false,
            status: "pending",
            tags: [CHAT_IMPORTER_TAGS[importerKey]],
            speakers: speakersOf(raw),
          })
          count += 1
        }
        return { sources: count }
      } catch (err) {
        return {
          sources: 0,
          error:
            err instanceof Error
              ? {
                  code: "importParseFailed",
                  params: { importer: importerKey, reason: err.message },
                }
              : {
                  code: "importParseFailedFallback",
                  params: { importer: importerKey },
                },
        }
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
      if (raws.length === 0) {
        return { sources: 0, error: { code: "dingTalkNoMessages" } }
      }
      let count = 0
      for (const raw of raws) {
        const fingerprint = await sha256(raw.text ?? "")
        await createTwinSource({
          twinId,
          kind: "chat",
          format: "markdown",
          source: raw.text ?? "",
          title: raw.filename,
          bytes: (raw.text ?? "").length,
          fingerprint,
          redacted: false,
          status: "pending",
          tags: ["dingtalk-export"],
          speakers: speakersOf(raw),
        })
        count += 1
      }
      return { sources: count }
    } catch (err) {
      return {
        sources: 0,
        error:
          err instanceof Error
            ? { code: "dingTalkParseFailed", params: { reason: err.message } }
            : { code: "dingTalkParseFailedFallback" },
      }
    }
  }

  // mbox / eml fan out into many sources via the importer layer.
  if (detected === "mbox" || detected === "eml") {
    const raws: RawSource[] =
      detected === "mbox"
        ? parseMbox(text, { twinId, source: file.name })
        : parseEml(text, { twinId, source: file.name })
    if (raws.length === 0) return { sources: 0, error: { code: "noMessagesParsed" } }
    let count = 0
    for (const raw of raws) {
      const fingerprint = await sha256(raw.text ?? "")
      await createTwinSource({
        twinId,
        kind: "email",
        format: "markdown", // importers emit pre-formatted markdown bodies
        source: raw.text ?? "",
        title: raw.filename,
        bytes: (raw.text ?? "").length,
        fingerprint,
        redacted: false,
        status: "pending",
        tags: [detected],
        speakers: speakersOf(raw),
      })
      count += 1
    }
    return { sources: count }
  }

  // Single-source path: one file → one twinSources row.
  const fingerprint = await sha256(text)
  await createTwinSource({
    twinId,
    kind: inferKind(detected),
    format: detected,
    source: text,
    title: file.name,
    bytes: text.length,
    fingerprint,
    redacted: false,
    status: "pending",
  })
  return { sources: 1 }
}

export interface TwinSourceUploaderProps {
  twinId: string
  onUploaded?: () => void
}

export function TwinSourceUploader({ twinId, onUploaded }: TwinSourceUploaderProps) {
  const t = useTranslations("twin.sourceUploader")
  const tErr = useTranslations("twin.sourceUploader.errors")
  /** Resolves an IngestError to a localized string. */
  const renderError = (err: IngestError): string => tErr(err.code, err.params)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [title, setTitle] = useState("")
  const [content, setContent] = useState("")
  const [format, setFormat] = useState<TwinSourceFormat>("markdown")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [batchSummary, setBatchSummary] = useState<IngestedFromFile | null>(null)
  const tauriAvailable = useSyncExternalStore(
    subscribeTauri,
    getTauriSnapshot,
    getServerTauriSnapshot
  )
  const [repoMaxCommits, setRepoMaxCommits] = useState(200)
  const [repoAuthor, setRepoAuthor] = useState("")
  const [repoSummary, setRepoSummary] = useState<{ path: string; commits: number } | null>(null)
  const [url, setUrl] = useState("")
  const [urlSubmitting, setUrlSubmitting] = useState(false)
  const [urlImported, setUrlImported] = useState<string | null>(null)

  /**
   * Fetch a URL through the shared web reader and stage its extracted text as
   * a single `pending` source. The reader already de-HTMLs the page, so we
   * persist `format:"markdown"` (like the binary-file path) — NOT the raw
   * content-type — so the ingest worker doesn't re-parse already-clean text.
   */
  const handleUrlSubmit = async () => {
    const trimmed = url.trim()
    if (!trimmed) {
      setError(tErr("urlEmpty"))
      return
    }
    const host = safeHostname(trimmed)
    if (!host) {
      setError(tErr("urlInvalid"))
      return
    }
    setUrlSubmitting(true)
    setError(null)
    setUrlImported(null)
    try {
      // CORS-free fetch + Jina fallback on Tauri; the browser falls back to the
      // global fetch (cross-origin requests may be blocked — see webModeHint).
      let fetchImpl: typeof fetch | undefined
      if (tauriAvailable) {
        const { createProxyFetch } = await import("@/lib/network/proxy-fetch")
        fetchImpl = createProxyFetch() as typeof fetch
      }
      const fetched = await fetchUrlAsRawSource(trimmed, {
        ...(fetchImpl ? { fetchImpl } : {}),
        jinaFallback: tauriAvailable,
      })
      const text = fetched.text.trim()
      if (!text) {
        setError(tErr("urlNoText"))
        return
      }
      const title = fetched.title.trim() || host
      const fingerprint = await sha256(text)
      await createTwinSource({
        twinId,
        kind: "document",
        format: "markdown",
        source: text,
        title,
        bytes: text.length,
        fingerprint,
        redacted: false,
        status: "pending",
        tags: ["url", host],
      })
      setUrl("")
      setUrlImported(title)
      onUploaded?.()
    } catch (err) {
      setError(tErr("urlFetchFailed", { reason: err instanceof Error ? err.message : String(err) }))
    } finally {
      setUrlSubmitting(false)
    }
  }

  const handleGitRepoPick = async () => {
    setSubmitting(true)
    setError(null)
    setRepoSummary(null)
    try {
      const { open } = await import("@tauri-apps/plugin-dialog")
      const picked = await open({ directory: true, multiple: false })
      if (!picked || typeof picked !== "string") {
        return
      }
      const raws = await parseGitRepo({
        twinId,
        repoPath: picked,
        maxCommits: repoMaxCommits > 0 ? repoMaxCommits : 200,
        author: repoAuthor.trim() || undefined,
      })
      if (raws.length === 0) {
        setError(tErr("noCommitsFound"))
        return
      }
      let count = 0
      for (const raw of raws) {
        const fingerprint = await sha256(raw.text ?? "")
        await createTwinSource({
          twinId,
          kind: "code",
          // git-repo importer emits markdown-with-fenced-diff bodies; keep the
          // tag for downstream filtering but store as markdown so the
          // existing parse/chunk path handles it.
          format: "markdown",
          source: raw.text ?? "",
          title: raw.filename,
          bytes: (raw.text ?? "").length,
          fingerprint,
          redacted: false,
          status: "pending",
          tags: ["git-repo"],
          speakers: speakersOf(raw),
        })
        count += 1
      }
      setRepoSummary({ path: picked, commits: count })
      onUploaded?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSubmitting(false)
    }
  }

  const handlePasteSubmit = async () => {
    if (!content.trim()) {
      setError(tErr("pasteContentRequired"))
      return
    }
    setSubmitting(true)
    setError(null)
    try {
      const fingerprint = await sha256(content)
      await createTwinSource({
        twinId,
        kind: inferKind(format),
        format,
        // `source` carries the body text for the worker to load (mirrors the
        // file/importer path, which stores extracted text here). The user's
        // optional label lives in `title`, NOT `source` — storing the label in
        // `source` dropped the pasted body so the worker embedded the label.
        source: content,
        title: title.trim() || `Pasted ${format} (${new Date().toLocaleString()})`,
        bytes: content.length,
        fingerprint,
        redacted: false,
        status: "pending",
      })
      setContent("")
      setTitle("")
      onUploaded?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSubmitting(false)
    }
  }

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return
    setSubmitting(true)
    setError(null)
    setBatchSummary(null)
    const summary: IngestedFromFile = { sources: 0, perFile: [] }
    try {
      for (const file of Array.from(files)) {
        try {
          const result = await ingestFile(file, twinId)
          summary.sources += result.sources
          summary.perFile.push({
            filename: file.name,
            sources: result.sources,
            error: result.error,
          })
        } catch (err) {
          summary.perFile.push({
            filename: file.name,
            sources: 0,
            error: {
              code: "parseFailed",
              params: { message: err instanceof Error ? err.message : String(err) },
            },
          })
        }
      }
      setBatchSummary(summary)
      if (summary.sources > 0) onUploaded?.()
    } finally {
      setSubmitting(false)
      // Reset the file input so picking the same file twice in a row works.
      if (fileInputRef.current) fileInputRef.current.value = ""
    }
  }

  return (
    <Card className="flex flex-col gap-4 p-4">
      <section className="flex flex-col gap-2">
        <h3 className="text-sm font-medium">{t("filesTitle")}</h3>
        <p className="text-muted-foreground text-xs">{t("filesDescription")}</p>
        <div className="flex items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={FILE_PICKER_ACCEPT}
            disabled={submitting}
            onChange={(e) => void handleFiles(e.target.files)}
            className="text-sm"
            aria-label={t("pickFilesAria")}
          />
        </div>
        {batchSummary ? (
          <div className="text-xs">
            <p className="font-medium">
              {batchSummary.sources === 1
                ? t("importedSummarySingular")
                : t("importedSummaryPlural", { count: batchSummary.sources })}
            </p>
            <ul className="mt-1 list-disc pl-5">
              {batchSummary.perFile.map((entry) => (
                <li key={entry.filename}>
                  <span className="font-mono">{entry.filename}</span> —{" "}
                  {entry.sources === 1
                    ? t("perFileSrcSingular")
                    : t("perFileSrcPlural", { count: entry.sources })}
                  {entry.error ? (
                    <span className="text-destructive"> ({renderError(entry.error)})</span>
                  ) : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      <hr className="border-border" />

      <section className="flex flex-col gap-3" data-testid="twin-source-uploader-url">
        <h3 className="text-sm font-medium">{t("urlTitle")}</h3>
        <p className="text-muted-foreground text-xs">{t("urlDescription")}</p>
        {!tauriAvailable ? (
          <p className="text-muted-foreground text-xs">{t("webModeHint")}</p>
        ) : null}
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="flex flex-1 flex-col gap-1">
            <Label htmlFor="twin-source-url">{t("urlLabel")}</Label>
            <Input
              id="twin-source-url"
              type="url"
              inputMode="url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder={t("urlPlaceholder")}
              disabled={urlSubmitting}
            />
          </div>
          <Button
            onClick={() => void handleUrlSubmit()}
            disabled={urlSubmitting}
            data-testid="twin-source-uploader-url-fetch"
          >
            {urlSubmitting ? (
              <>
                <Loader2Icon className="mr-1.5 size-3.5 animate-spin" aria-hidden />
                {t("fetching")}
              </>
            ) : (
              t("addUrl")
            )}
          </Button>
        </div>
        {urlImported ? (
          <p className="text-xs" data-testid="twin-source-uploader-url-imported">
            {t("urlImported", { title: urlImported })}
          </p>
        ) : null}
      </section>

      <hr className="border-border" />

      {tauriAvailable ? (
        <>
          <section className="flex flex-col gap-3" data-testid="twin-source-uploader-gitrepo">
            <h3 className="text-sm font-medium">{t("gitRepoTitle")}</h3>
            <p className="text-muted-foreground text-xs">{t("gitRepoDescription")}</p>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
              <div className="flex flex-col gap-1">
                <Label htmlFor="twin-source-repo-max-commits">{t("maxCommits")}</Label>
                <Input
                  id="twin-source-repo-max-commits"
                  type="number"
                  min={1}
                  max={2000}
                  value={repoMaxCommits}
                  onChange={(e) => setRepoMaxCommits(Number.parseInt(e.target.value, 10) || 200)}
                  className="w-32"
                />
              </div>
              <div className="flex flex-1 flex-col gap-1">
                <Label htmlFor="twin-source-repo-author">{t("authorFilter")}</Label>
                <Input
                  id="twin-source-repo-author"
                  value={repoAuthor}
                  onChange={(e) => setRepoAuthor(e.target.value)}
                  placeholder={t("authorPlaceholder")}
                />
              </div>
              <Button
                onClick={() => void handleGitRepoPick()}
                disabled={submitting}
                data-testid="twin-source-uploader-gitrepo-pick"
              >
                {submitting ? (
                  <>
                    <Loader2Icon className="mr-1.5 size-3.5 animate-spin" aria-hidden />
                    {t("walking")}
                  </>
                ) : (
                  t("pickRepoFolder")
                )}
              </Button>
            </div>
            {repoSummary ? (
              <p className="text-xs">
                {repoSummary.commits === 1
                  ? t("repoImportedSingular")
                  : t("repoImportedPlural", { count: repoSummary.commits })}{" "}
                <span className="font-mono">{repoSummary.path}</span>.
              </p>
            ) : null}
          </section>

          <hr className="border-border" />
        </>
      ) : null}

      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-medium">{t("pasteTitle")}</h3>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="flex flex-1 flex-col gap-1">
            <Label htmlFor="twin-source-title">{t("titleLabel")}</Label>
            <Input
              id="twin-source-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t("titlePlaceholder")}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="twin-source-format">{t("formatLabel")}</Label>
            <Select value={format} onValueChange={(next) => setFormat(next as TwinSourceFormat)}>
              <SelectTrigger
                id="twin-source-format"
                className="w-[12rem]"
                aria-label={t("formatLabel")}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FORMATS.map((f) => (
                  <SelectItem key={f} value={f}>
                    {f}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <Label htmlFor="twin-source-content">{t("contentLabel")}</Label>
          <Textarea
            id="twin-source-content"
            rows={8}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder={t("contentPlaceholder")}
          />
        </div>

        <div className="flex justify-end">
          <Button onClick={() => void handlePasteSubmit()} disabled={submitting}>
            {submitting ? (
              <>
                <Loader2Icon className="mr-1.5 size-3.5 animate-spin" aria-hidden />
                {t("saving")}
              </>
            ) : (
              t("savePastedSource")
            )}
          </Button>
        </div>
      </section>

      {error ? (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      ) : null}
    </Card>
  )
}
