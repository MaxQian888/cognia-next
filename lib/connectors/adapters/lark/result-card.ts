/**
 * Lark "result card" builder — the completed ai-run answer surface.
 *
 * Today a finished reply ships as a bare Card-1.0 `{elements:[{tag:"div",
 * text:{tag:"lark_md"}}]}` (see `card.ts` `segmentToLarkBody`): no header
 * state, no quote of the triggering message, no footer, and inline
 * `![](…)` images render as raw markdown text. This module projects the
 * final answer into a proper Card 2.0 result card, mirroring the shape the
 * aiden-bot lark-daemon converged on:
 *
 *   {schema:"2.0", config:{update_multi, summary, width_mode?}, header?,
 *    body:{elements:[ quote?, interrupted?, answer…, img…, hr+note? ]}}
 *
 * Design notes:
 *   - The answer is model-authored markdown rendered VERBATIM (Lark card
 *     markdown accepts standard syntax incl. `>` blockquotes) — the only
 *     sanitisation is neutralising `<at ` sequences so model text cannot
 *     mass-ping a chat.
 *   - `![](url)` spans become real `{tag:"img"}` elements IN PLACE. Lark
 *     `img_key` accepts only uploaded keys, never a URL — the raw URL/path
 *     rides in `img_key` as a placeholder and `resolveLarkMediaKeys`
 *     (upload.ts) swaps it for the real `image_key`, degrading to a link
 *     or dropping the element when the source can never upload.
 *   - The card is a `{type:"card"}` segment; `isLarkCardPayload` passes the
 *     `schema:"2.0"` payload through verbatim — but ONLY for a standalone
 *     segment. The multi-segment combiner would merge it into another
 *     interactive body as a "[card]" placeholder, so the runtime enqueues
 *     the card as its own request (the shape every existing card reply
 *     already uses).
 *
 * Connector-side strings are inline bilingual literals — no next-intl here
 * (same convention as `buildToolApprovalSurface`).
 */

import type { MessageSegment } from "@/types/connectors/segment"

export type LarkResultCardStatus = "done" | "error" | "interrupted"

export interface LarkResultCardInput {
  /** Final answer markdown (model-authored; rendered verbatim, not escaped). */
  answer: string
  status: LarkResultCardStatus
  /** Triggering user message snippet; renders as a `> 回复：…` blockquote. */
  quote?: string
  /** Turn wall-clock time; footer's elapsed readout. */
  elapsedMs?: number
  /** Lark open_id (`ou_…`) of the person who asked; footer's `<at id=…>`. */
  initiatorOpenId?: string
  /** Absolute web URL to the run detail page. */
  detailsUrl?: string
}

/** Lark markdown elements silently truncate oversized content; stay well under. */
const ANSWER_ELEMENT_LIMIT = 3000
/** Quote line clamp — a gist of the triggering message, not the message. */
const QUOTE_LIMIT = 120
/** Card `config.summary` is the chat-list / push-notification preview text. */
const SUMMARY_LIMIT = 60
/** Lark open_id shape — anything else can never be an `<at id>` target. */
const OPEN_ID_PATTERN = /^ou_[A-Za-z0-9]+$/
/** Details links render only for real web URLs (`buildRunDetailsUrl` emits http/https). */
const WEB_URL_PATTERN = /^https?:\/\//
/** `![alt](url)` spans inside the answer markdown. */
const IMAGE_SPAN_PATTERN = /!\[([^\]]*)\]\(([^)\n]+)\)/g
/** File-path-ish image sources: an image extension implies a path. */
const IMAGE_EXTENSION_PATTERN = /\.(?:png|jpe?g|gif|webp|bmp)(?:[?#].*)?$/i
/** A real `<at` mention opener — `<at ` / `<at>` / `<at=`; `<attach` is safe. */
const MENTION_OPENER_PATTERN = /<at\b/gi
/** Zero-width space — breaks the `<at` token without a visible glyph. */
const ZWSP = "\u200B"

const HEADER_BY_STATUS: Record<
  Exclude<LarkResultCardStatus, "done">,
  { title: string; template: string }
> = {
  error: { title: "出错了 / Something went wrong", template: "red" },
  interrupted: { title: "任务已停止 / Stopped", template: "orange" },
}

const SUMMARY_FALLBACK: Record<LarkResultCardStatus, string> = {
  done: "回复 / Reply",
  error: "出错了 / Something went wrong",
  interrupted: "任务已停止 / Stopped",
}

/**
 * Neutralise `<at ` sequences so model-authored text cannot mass-ping the
 * chat — a zero-width space inside the token keeps it readable but inert.
 * Nothing else is escaped: the answer is model markdown rendered verbatim.
 */
function neutralizeMentions(text: string): string {
  return text.replace(MENTION_OPENER_PATTERN, `<${ZWSP}at`)
}

/**
 * One-line escaped quote for the `> 回复：…` element. Whitespace collapses
 * (the blockquote is a single-line gist), the result clamps to 120 chars,
 * and `&`/`<`/`>` escape to entities so the quoted text cannot break out
 * of the blockquote or mint a real `<at>` mention.
 */
function sanitizeQuote(quote: string): string {
  const flat = quote.replace(/\s+/g, " ").trim()
  const clamped = flat.length > QUOTE_LIMIT ? `${flat.slice(0, QUOTE_LIMIT - 1)}…` : flat
  return clamped.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
}

/**
 * Whether an `![](url)` target can become a real card image. Remote
 * http(s) URLs and `data:image/` inline bytes upload through the media
 * pre-pass; local/relative file paths (absolute `/…`, `./…`, `~/…`, or a
 * bare image-extensioned name like `chart.png`) are emitted too — the
 * pre-pass drops them since there is no linkable form to fall back to.
 * Anything else (`ftp://`, bare text, …) stays literal markdown.
 */
function isCardImageSource(url: string): boolean {
  return (
    /^https?:\/\//i.test(url) ||
    /^data:image\//i.test(url) ||
    url.startsWith("/") ||
    url.startsWith("./") ||
    url.startsWith("~/") ||
    IMAGE_EXTENSION_PATTERN.test(url)
  )
}

/** Markdown image span with an optional ` "title"` tail stripped off the URL. */
function imageTarget(raw: string): string {
  const trimmed = raw.trim()
  const titled = trimmed.match(/^(\S+)\s+["'][^"']*["']$/)
  return titled ? titled[1] : trimmed
}

type AnswerPart = { kind: "md"; text: string } | { kind: "img"; url: string; alt: string }

/** Split the answer into text runs and image markers, preserving order. */
function tokenizeAnswer(answer: string): AnswerPart[] {
  const parts: AnswerPart[] = []
  let cursor = 0
  for (const match of answer.matchAll(IMAGE_SPAN_PATTERN)) {
    const url = imageTarget(match[2])
    if (!isCardImageSource(url)) continue
    if (match.index > cursor) parts.push({ kind: "md", text: answer.slice(cursor, match.index) })
    parts.push({ kind: "img", url, alt: match[1] })
    cursor = match.index + match[0].length
  }
  if (cursor < answer.length) parts.push({ kind: "md", text: answer.slice(cursor) })
  return parts
}

/**
 * Greedy packer: split markdown into ≤ `limit` chunks at blank-line
 * boundaries (each element reads as its own paragraph block anyway).
 * Oversized single paragraphs fall back to line boundaries, and only a
 * single unbreakable line is hard-cut at the limit.
 */
function splitMarkdownChunks(text: string, limit = ANSWER_ELEMENT_LIMIT): string[] {
  if (text.length <= limit) return [text]
  const chunks: string[] = []
  let current = ""
  const flush = () => {
    if (current) chunks.push(current)
    current = ""
  }
  for (const paragraph of text.split(/\n{2,}/)) {
    const candidate = current ? `${current}\n\n${paragraph}` : paragraph
    if (candidate.length <= limit) {
      current = candidate
      continue
    }
    flush()
    if (paragraph.length <= limit) {
      current = paragraph
      continue
    }
    // Oversized paragraph — pack by single line breaks before hard-cutting.
    for (let line of paragraph.split("\n")) {
      const candidateLine = current ? `${current}\n${line}` : line
      if (candidateLine.length <= limit) {
        current = candidateLine
        continue
      }
      flush()
      while (line.length > limit) {
        chunks.push(line.slice(0, limit))
        line = line.slice(limit)
      }
      current = line
    }
  }
  flush()
  return chunks
}

/** Push-notification / chat-list preview: the first ~60 chars of the answer. */
function summaryContent(answer: string, status: LarkResultCardStatus): string {
  const text = answer.trim().slice(0, SUMMARY_LIMIT)
  return text || SUMMARY_FALLBACK[status]
}

function footerElements(input: LarkResultCardInput): Record<string, unknown>[] {
  const parts: string[] = []
  if (input.initiatorOpenId && OPEN_ID_PATTERN.test(input.initiatorOpenId)) {
    parts.push(`<at id=${input.initiatorOpenId}></at>`)
  }
  if (input.detailsUrl && WEB_URL_PATTERN.test(input.detailsUrl)) {
    parts.push(`[查看详情 / Details](${input.detailsUrl})`)
  }
  if (input.elapsedMs !== undefined && Number.isFinite(input.elapsedMs)) {
    parts.push(`耗时 ${(input.elapsedMs / 1000).toFixed(1)}s / elapsed`)
  }
  if (input.status === "interrupted") {
    parts.push("<font color='red'>已被用户中断 / Interrupted</font>")
  }
  if (parts.length === 0) return []
  return [
    { tag: "hr" },
    {
      tag: "note",
      element_id: "footer",
      elements: [{ tag: "lark_md", content: parts.join(" · ") }],
    },
  ]
}

/**
 * Build the Card 2.0 result card payload.
 *
 * `done` omits the header entirely (the terminal card needs no state
 * banner); `error` and `interrupted` carry a coloured title bar, and
 * `interrupted` additionally prepends the 🛑 status line and compacts the
 * card width.
 */
export function buildLarkResultCard(input: LarkResultCardInput): Record<string, unknown> {
  const elements: Record<string, unknown>[] = []

  if (input.quote?.trim()) {
    elements.push({
      tag: "markdown",
      element_id: "quote",
      content: `> 回复：${sanitizeQuote(input.quote)}`,
    })
  }

  if (input.status === "interrupted") {
    elements.push({
      tag: "markdown",
      element_id: "interrupted_status",
      content: "🛑 **任务已停止 / Stopped**",
      text_size: "notation",
    })
  }

  let mdCount = 0
  let imgCount = 0
  const answer = neutralizeMentions(input.answer)
  for (const part of tokenizeAnswer(answer)) {
    if (part.kind === "img") {
      elements.push({
        tag: "img",
        element_id: `answer_img_${imgCount}`,
        // Placeholder: the URL/path rides here until the upload pre-pass
        // swaps in a real image_key (or degrades to a link / drops it).
        img_key: part.url,
        alt: { tag: "plain_text", content: part.alt || "image" },
      })
      imgCount += 1
      continue
    }
    for (const chunk of splitMarkdownChunks(part.text)) {
      if (!chunk.trim()) continue
      elements.push({
        tag: "markdown",
        element_id: mdCount === 0 ? "answer" : `answer_${mdCount}`,
        content: chunk,
      })
      mdCount += 1
    }
  }
  if (mdCount === 0 && imgCount === 0) {
    elements.push({ tag: "markdown", element_id: "answer", content: "—" })
  }

  elements.push(...footerElements(input))

  const card: Record<string, unknown> = {
    schema: "2.0",
    config: {
      update_multi: true,
      summary: { content: summaryContent(input.answer, input.status) },
      ...(input.status === "interrupted" ? { width_mode: "compact" } : {}),
    },
    body: { elements },
  }
  if (input.status !== "done") {
    const header = HEADER_BY_STATUS[input.status]
    card["header"] = {
      title: { tag: "plain_text", content: header.title },
      template: header.template,
    }
  }
  return card
}

/** Wrap the payload as a standalone card segment (verbatim passthrough). */
export function buildLarkResultCardSegment(input: LarkResultCardInput): MessageSegment {
  return { type: "card", card: { kind: "lark", payload: buildLarkResultCard(input) } }
}

export interface WithLarkResultCardInput extends Omit<LarkResultCardInput, "answer"> {
  /**
   * Answer used when the segment list carries no markdown/text to wrap —
   * e.g. an empty `outboundSegments` whose whole reply is the card.
   */
  fallbackAnswer?: string
}

/**
 * Project the final answer into a result-card segment inside a projected
 * outbound segment list: the LAST markdown/text segment's content becomes
 * the card's answer and is replaced in place; leading a2ui / media
 * segments pass through untouched. When no markdown/text segment exists
 * the card is appended — but only when `fallbackAnswer` is non-empty.
 *
 * The returned list may mix the card with other segments; the caller is
 * responsible for shipping the card as its own outbound request (the
 * Lark multi-segment combiner would otherwise degrade it to "[card]").
 */
export function withLarkResultCard(
  segments: MessageSegment[],
  input: WithLarkResultCardInput
): MessageSegment[] {
  let answerIndex = -1
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    if (segments[i].type === "markdown" || segments[i].type === "text") {
      answerIndex = i
      break
    }
  }
  if (answerIndex >= 0) {
    const seg = segments[answerIndex]
    // The scan above only stops on markdown | text, so the second branch
    // is always a text segment — the `""` fallback is unreachable.
    const answer = seg.type === "markdown" ? seg.md : seg.type === "text" ? seg.text : ""
    const card = buildLarkResultCardSegment({ ...input, answer })
    return [...segments.slice(0, answerIndex), card, ...segments.slice(answerIndex + 1)]
  }
  const fallback = input.fallbackAnswer?.trim()
  if (fallback) {
    return [...segments, buildLarkResultCardSegment({ ...input, answer: input.fallbackAnswer! })]
  }
  return segments
}

/**
 * Group a segment list into per-request units for `enqueueOutbound`.
 * A `card` segment only survives Lark serialization verbatim as its
 * request's SOLE segment — the multi-segment combiner degrades a mixed-in
 * card to a "[card]" label — so each card becomes its own group while
 * contiguous non-card runs keep today's combined body. Order is
 * preserved; `[a2ui, card]` enqueues the surface message first, then the
 * result card.
 */
export function splitLarkCardSegments(segments: MessageSegment[]): MessageSegment[][] {
  const groups: MessageSegment[][] = []
  let run: MessageSegment[] = []
  for (const seg of segments) {
    if (seg.type === "card") {
      if (run.length > 0) {
        groups.push(run)
        run = []
      }
      groups.push([seg])
      continue
    }
    run.push(seg)
  }
  if (run.length > 0) groups.push(run)
  return groups
}
