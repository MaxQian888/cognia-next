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
 *   2. **Paste text** — the original Phase 7 path; useful for snippets or
 *      content that doesn't live in a file (slack message dumps, prose
 *      notes, etc.).
 */

import { useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import { createTwinSource } from "@/lib/db/twin-sources"
import { detectSourceFormat, listSupportedFormats } from "@/lib/twin/ingest"
import { parseMbox, parseEml } from "@/lib/twin/importers"
import type { RawSource } from "@/lib/twin/ingest"
import type { TwinSourceFormat, TwinSourceKind } from "@/types/twin"

const FORMATS: TwinSourceFormat[] = listSupportedFormats() as TwinSourceFormat[]

/**
 * Extensions accepted by the file picker. Binary formats are parsed in the
 * browser; only the extracted text lands in Dexie.
 */
const FILE_PICKER_ACCEPT = [
  // Text
  ".md",
  ".markdown",
  ".txt",
  ".csv",
  ".tsv",
  ".html",
  ".htm",
  ".json",
  ".eml",
  ".mbox",
  ".rtf",
  // Code
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".py",
  ".go",
  ".rs",
  ".java",
  ".cpp",
  ".c",
  ".h",
  ".swift",
  ".kt",
  // Binary (parsed client-side)
  ".pdf",
  ".docx",
  ".pptx",
  ".odt",
  ".odp",
  ".epub",
].join(",")

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
 * Formats handled by `lib/document/document-processor:processDocumentAsync`.
 * Parsed in the browser; we persist the resulting text only.
 */
const BINARY_FORMATS: ReadonlySet<TwinSourceFormat> = new Set<TwinSourceFormat>([
  "pdf",
  "docx",
  "pptx",
  "odt",
  "odp",
  "epub",
])

function inferKind(format: TwinSourceFormat): TwinSourceKind {
  if (format === "code" || format === "git-repo") return "code"
  if (format === "mbox" || format === "eml") return "email"
  if (format.endsWith("-export")) return "chat"
  return "document"
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

interface IngestedFromFile {
  /** Sources actually created (already written to Dexie). */
  sources: number
  /** Per-file diagnostic — used to render the post-batch summary. */
  perFile: Array<{ filename: string; sources: number; error?: string }>
}

async function ingestFile(
  file: File,
  twinId: string
): Promise<{ sources: number; error?: string }> {
  const detected = detectSourceFormat(file.name)
  if (!detected) {
    return { sources: 0, error: "Unknown file type — pick the format manually via paste mode." }
  }

  // Binary formats — parse in the browser via the ported document processor
  // and persist only the extracted text. The worker / scheduler stay
  // text-only.
  if (BINARY_FORMATS.has(detected)) {
    try {
      const buffer = await readFileAsArrayBuffer(file)
      const { processDocumentAsync } = await import("@/lib/document/document-processor")
      const tempId = `tws_pre_${twinId}_${Date.now().toString(36)}`
      const processed = await processDocumentAsync(tempId, file.name, buffer, {
        extractEmbeddable: true,
      })
      const text = processed.embeddableContent || processed.content
      if (!text.trim()) {
        return { sources: 0, error: `Parsed ${detected} but no text was extracted.` }
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
          err instanceof Error ? `Failed to parse ${detected}: ${err.message}` : "Parse failed",
      }
    }
  }

  if (!TEXTUAL_FORMATS.has(detected)) {
    return {
      sources: 0,
      error: `Format "${detected}" is not yet supported in the file picker. Paste-text path still works.`,
    }
  }

  const text = await readFileAsText(file)
  if (!text.trim()) {
    return { sources: 0, error: "File is empty." }
  }

  // mbox / eml fan out into many sources via the importer layer.
  if (detected === "mbox" || detected === "eml") {
    const raws: RawSource[] =
      detected === "mbox"
        ? parseMbox(text, { twinId, source: file.name })
        : parseEml(text, { twinId, source: file.name })
    if (raws.length === 0) return { sources: 0, error: "No messages parsed from the file." }
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
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [title, setTitle] = useState("")
  const [content, setContent] = useState("")
  const [format, setFormat] = useState<TwinSourceFormat>("markdown")
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [batchSummary, setBatchSummary] = useState<IngestedFromFile | null>(null)

  const handlePasteSubmit = async () => {
    if (!content.trim()) {
      setError("Paste some content before saving")
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
        source: title.trim() || "manual paste",
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
            error: err instanceof Error ? err.message : String(err),
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
        <h3 className="text-sm font-medium">From file(s)</h3>
        <p className="text-muted-foreground text-xs">
          Text formats (Markdown / CSV / HTML / JSON / source code / .eml / .mbox) are stored as-is.
          Binary formats (PDF / DOCX / PPTX / EPUB / ODT / ODP) are parsed in the browser; only the
          extracted text lands in Dexie. mbox files produce one source per message.
        </p>
        <div className="flex items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept={FILE_PICKER_ACCEPT}
            disabled={submitting}
            onChange={(e) => void handleFiles(e.target.files)}
            className="text-sm"
            aria-label="Pick text files"
          />
        </div>
        {batchSummary ? (
          <div className="text-xs">
            <p className="font-medium">
              Imported {batchSummary.sources} source
              {batchSummary.sources === 1 ? "" : "s"}.
            </p>
            <ul className="mt-1 list-disc pl-5">
              {batchSummary.perFile.map((entry) => (
                <li key={entry.filename}>
                  <span className="font-mono">{entry.filename}</span> — {entry.sources} src
                  {entry.error ? <span className="text-destructive"> ({entry.error})</span> : null}
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </section>

      <hr className="border-border" />

      <section className="flex flex-col gap-3">
        <h3 className="text-sm font-medium">Or paste text</h3>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
          <div className="flex flex-1 flex-col gap-1">
            <Label htmlFor="twin-source-title">Title (optional)</Label>
            <Input
              id="twin-source-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. onboarding-notes.md"
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="twin-source-format">Format</Label>
            <select
              id="twin-source-format"
              className="border-border bg-background h-9 rounded border px-2 text-sm"
              value={format}
              onChange={(e) => setFormat(e.target.value as TwinSourceFormat)}
            >
              {FORMATS.map((f) => (
                <option key={f} value={f}>
                  {f}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <Label htmlFor="twin-source-content">Content</Label>
          <Textarea
            id="twin-source-content"
            rows={8}
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="Paste markdown, code, or exported chat content here…"
          />
        </div>

        <div className="flex justify-end">
          <Button onClick={() => void handlePasteSubmit()} disabled={submitting}>
            {submitting ? "Saving…" : "Save pasted source"}
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
