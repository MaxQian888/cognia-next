/**
 * mbox importer — splits an RFC-4155 mailbox file into one `RawSource`
 * per message. Each message becomes a small markdown-formatted document
 * with `From / To / Subject / Date` headers up top and the body below,
 * routed through the document-processor branch of the ingest pipeline.
 *
 * The format is intentionally minimal: we don't try to decode quoted-
 * printable, base64 multipart, or attachments. mbox is overwhelmingly
 * used for plain-text mail (Gmail Takeout, Apple Mail export); when a
 * message *is* multipart the parser falls back to the raw body so the
 * embedder still sees something useful.
 */

import type { RawSource } from "@/lib/twin/ingest/parse"

const FROM_LINE_RE = /^From [^\n]*\n/m
const HEADER_BODY_SPLIT_RE = /\n\r?\n/

export interface MboxImportOptions {
  /** Twin id stamped onto each emitted source. */
  twinId: string
  /** Optional file path / display label for the whole mbox. */
  source?: string
}

/** Parse an mbox text blob into one RawSource per message. */
export function parseMbox(content: string, options: MboxImportOptions): RawSource[] {
  if (!content.trim()) return []

  // mbox messages are separated by lines starting with "From " (followed by
  // sender + date). The first message also starts with such a line; we split
  // on the marker but keep the marker itself stripped from each part.
  const parts = splitOnMboxBoundary(content)
  const sources: RawSource[] = []
  parts.forEach((rawMessage, index) => {
    const cleaned = rawMessage.trim()
    if (!cleaned) return
    const formatted = formatMessage(cleaned)
    if (!formatted) return
    sources.push({
      id: makeMessageId(options.twinId, index, formatted.subject),
      filename: `${options.source ?? "mbox-export"}/message-${index + 1}.md`,
      format: "markdown",
      text: formatted.body,
      baseMetadata: {
        speakers: [formatted.from, formatted.to].filter((x): x is string => Boolean(x)),
        timestamp: formatted.timestampMs,
      },
    })
  })
  return sources
}

interface ParsedMessage {
  body: string
  from?: string
  to?: string
  subject: string
  timestampMs?: number
}

function formatMessage(raw: string): ParsedMessage | null {
  const split = raw.match(HEADER_BODY_SPLIT_RE)
  if (!split || split.index === undefined) {
    // No blank-line separator — treat the whole thing as body.
    return { body: raw, subject: "(no subject)" }
  }
  const headerBlock = raw.slice(0, split.index)
  const body = raw.slice(split.index + split[0].length).trim()
  const headers = parseHeaders(headerBlock)
  const subject = headers["subject"] ?? "(no subject)"
  const from = headers["from"]
  const to = headers["to"]
  const dateStr = headers["date"]
  const timestampMs = dateStr ? Date.parse(dateStr) : NaN

  // Compose a little markdown front-matter so the parser keeps the headers
  // visible and the embedder sees structured context.
  const formatted = [
    `# ${subject}`,
    "",
    from ? `**From:** ${from}` : null,
    to ? `**To:** ${to}` : null,
    dateStr ? `**Date:** ${dateStr}` : null,
    "",
    body,
  ]
    .filter((line): line is string => line !== null)
    .join("\n")
  return {
    body: formatted,
    from,
    to,
    subject,
    timestampMs: Number.isFinite(timestampMs) ? timestampMs : undefined,
  }
}

function parseHeaders(headerBlock: string): Record<string, string> {
  // Headers may be folded across continuation lines (RFC 2822 §2.2.3 — a
  // continuation line begins with whitespace). Unfold first, then split.
  const unfolded = headerBlock.replace(/\r?\n[ \t]+/g, " ")
  const headers: Record<string, string> = {}
  for (const line of unfolded.split(/\r?\n/)) {
    const colon = line.indexOf(":")
    if (colon <= 0) continue
    const key = line.slice(0, colon).trim().toLowerCase()
    const value = line.slice(colon + 1).trim()
    if (key && value && !(key in headers)) headers[key] = value
  }
  return headers
}

function splitOnMboxBoundary(text: string): string[] {
  // The "From " marker is mbox's separator. Treat the start-of-file as a
  // free-floating boundary too so we capture the first message.
  const matches = [...text.matchAll(/(?:^|\n)From [^\n]*\n/g)]
  if (matches.length === 0) return [text]
  const segments: string[] = []
  for (let i = 0; i < matches.length; i++) {
    const start = (matches[i].index ?? 0) + matches[i][0].length
    const end = i + 1 < matches.length ? (matches[i + 1].index ?? text.length) : text.length
    segments.push(text.slice(start, end))
  }
  return segments
}

function makeMessageId(twinId: string, index: number, subject: string): string {
  const slug = subject.replace(/[^a-z0-9]+/gi, "-").slice(0, 32) || "message"
  return `tws_mbox_${twinId}_${index}_${slug}`
}

/** Extension-aware quick check used by the importer registry. */
export function detectMbox(content: string): boolean {
  return FROM_LINE_RE.test(content)
}
