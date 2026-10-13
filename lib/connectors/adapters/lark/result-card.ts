/**
 * Lark "result card" builder — the completed ai-run answer surface.
 *
 * The completed answer as a Card 2.0 result card (`segmentToLarkBody`
 * would otherwise send a bare markdown block): no header when it succeeded,
 * a coloured one when it failed or stopped, an optional quote of the
 * triggering message, the answer, and one grey footer line. Its words follow
 * the reader's language (`locale`), Chinese when that is unknown:
 *
 *   {schema:"2.0", config:{update_multi, summary, width_mode?}, header?,
 *    body:{elements:[ quote?, answer…, img…, footer? ]}}
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
 * Connector-side strings are inline literals in both languages — no next-intl
 * here (same convention as `buildToolApprovalSurface`).
 */

import type { MessageSegment } from "@/types/connectors/segment"
import {
  normalizeLarkCardPresentation,
  larkCardBodyStyle,
  larkCardHeaderTheme,
  larkCardConfigStyle,
  larkCardMarkdownStyle,
  larkCardHeaderExtras,
} from "./card-presentation"
import {
  LARK_ICON,
  larkCardHeader,
  larkToneTemplate,
  type LarkCardTone,
  type LarkIcon,
} from "./card-kit"

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
  presentation?: unknown
  /** The reader's language (`larkReplyLocale`); Chinese when unknown. */
  locale?: string
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

/** The card's words, in the reader's language. */
const RESULT_TEXT = {
  zh: {
    error: "出错了",
    interrupted: "任务已停止",
    reply: "回复",
    quote: "回复：",
    details: "查看详情",
    elapsed: (seconds: string) => `用时 ${seconds}s`,
    interruptedNote: "已被中断",
  },
  en: {
    error: "Something went wrong",
    interrupted: "Stopped",
    reply: "Reply",
    quote: "Re: ",
    details: "Details",
    elapsed: (seconds: string) => `Elapsed ${seconds}s`,
    interruptedNote: "Interrupted",
  },
} as const

type ResultText = (typeof RESULT_TEXT)["zh" | "en"]

function resultText(locale: string | undefined): ResultText {
  return locale && !locale.toLowerCase().startsWith("zh") ? RESULT_TEXT.en : RESULT_TEXT.zh
}

const HEADER_BY_STATUS: Record<
  Exclude<LarkResultCardStatus, "done">,
  { title: (text: ResultText) => string; tone: LarkCardTone; icon: LarkIcon }
> = {
  error: { title: (text) => text.error, tone: "danger", icon: LARK_ICON.error },
  interrupted: { title: (text) => text.interrupted, tone: "warning", icon: LARK_ICON.stop },
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
function summaryContent(answer: string, status: LarkResultCardStatus, text: ResultText): string {
  const preview = answer.trim().slice(0, SUMMARY_LIMIT)
  return (
    preview || (status === "done" ? text.reply : status === "error" ? text.error : text.interrupted)
  )
}

/**
 * One quiet line under the answer: who asked (groups only), time, details.
 * Each part carries its own colour: a mention inside a `<font>` would not
 * render as one, and the red interrupted mark must not nest in the grey.
 */
function footerElements(input: LarkResultCardInput, text: ResultText): Record<string, unknown>[] {
  const grey = (content: string) => `<font color='grey'>${content}</font>`
  const parts: string[] = []
  if (input.initiatorOpenId && OPEN_ID_PATTERN.test(input.initiatorOpenId)) {
    parts.push(`<at id=${input.initiatorOpenId}></at>`)
  }
  if (input.elapsedMs !== undefined && Number.isFinite(input.elapsedMs)) {
    parts.push(grey(text.elapsed((input.elapsedMs / 1000).toFixed(1))))
  }
  if (input.detailsUrl && WEB_URL_PATTERN.test(input.detailsUrl)) {
    parts.push(`[${text.details}](${input.detailsUrl})`)
  }
  if (input.status === "interrupted") {
    parts.push(`<font color='red'>${text.interruptedNote}</font>`)
  }
  if (parts.length === 0) return []
  return [
    {
      tag: "markdown",
      element_id: "footer",
      content: parts.join(grey(" · ")),
      text_size: "notation",
      margin: "4px 0 0 0",
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
  const presentation = normalizeLarkCardPresentation(input.presentation)
  const text = resultText(input.locale)
  const elements: Record<string, unknown>[] = []

  if (presentation.showQuote && input.quote?.trim()) {
    elements.push({
      tag: "markdown",
      element_id: "quote",
      content: `> ${text.quote}${sanitizeQuote(input.quote)}`,
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
        ...larkCardMarkdownStyle(presentation),
      })
      mdCount += 1
    }
  }
  if (mdCount === 0 && imgCount === 0) {
    elements.push({ tag: "markdown", element_id: "answer", content: "—" })
  }

  if (presentation.showFooter)
    elements.push(
      ...footerElements(
        { ...input, elapsedMs: presentation.showElapsed ? input.elapsedMs : undefined },
        text
      )
    )

  const card: Record<string, unknown> = {
    schema: "2.0",
    config: {
      update_multi: true,
      ...larkCardConfigStyle(presentation),
      ...(presentation.width !== "default" ? { width_mode: presentation.width } : {}),
      summary: { content: summaryContent(input.answer, input.status, text) },
      ...(input.status === "interrupted" && presentation.width === "default"
        ? { width_mode: "compact" }
        : {}),
    },
    body: { ...larkCardBodyStyle(presentation), elements },
  }
  if (input.status !== "done") {
    const header = HEADER_BY_STATUS[input.status]
    card["header"] = {
      ...larkCardHeader({ title: header.title(text), tone: header.tone, icon: header.icon }),
      ...larkCardHeaderExtras(presentation),
      template: larkCardHeaderTheme(presentation, larkToneTemplate(header.tone)),
    }
  } else if (
    presentation.title ||
    presentation.subtitle ||
    presentation.headerIconKey ||
    presentation.headerTags
  ) {
    card.header = {
      ...larkCardHeader({ title: presentation.title || text.reply, tone: "success" }),
      ...larkCardHeaderExtras(presentation),
      template: larkCardHeaderTheme(presentation, "green"),
    }
  }
  return card
}

/** Wrap the payload as a standalone card segment (verbatim passthrough). */
export function buildLarkResultCardSegment(input: LarkResultCardInput): MessageSegment {
  const fallback = buildLarkResultCard(input)
  const presentation = normalizeLarkCardPresentation(input.presentation)
  if (input.status === "done" && presentation.resultTemplateEnabled) {
    const payload: LarkResultTemplatePayload = {
      type: "template",
      data: {
        template_id: presentation.resultTemplateId,
        template_version_name: presentation.resultTemplateVersion,
        template_variable: {
          answer: neutralizeMentions(input.answer),
          status: input.status,
          title: presentation.title || resultText(input.locale).reply,
          quote: presentation.showQuote ? sanitizeQuote(input.quote ?? "") : "",
          elapsed_ms:
            presentation.showElapsed && Number.isFinite(input.elapsedMs)
              ? Math.max(0, input.elapsedMs!)
              : 0,
          details_url:
            input.detailsUrl && WEB_URL_PATTERN.test(input.detailsUrl) ? input.detailsUrl : "",
        },
      },
      fallback,
    }
    return { type: "card", card: { kind: "lark", payload } }
  }
  return { type: "card", card: { kind: "lark", payload: fallback } }
}

/** Internal delivery envelope: the adapter consumes fallback before any network request. */
export interface LarkResultTemplatePayload {
  type: "template"
  data: {
    template_id: string
    template_version_name: string
    template_variable: Record<string, string | number>
  }
  fallback: Record<string, unknown>
}

export function isLarkResultTemplatePayload(value: unknown): value is LarkResultTemplatePayload {
  if (!value || typeof value !== "object") return false
  const candidate = value as Partial<LarkResultTemplatePayload>
  return (
    candidate.type === "template" &&
    typeof candidate.data?.template_id === "string" &&
    /^[A-Za-z0-9_.-]{1,100}$/.test(candidate.data.template_id) &&
    typeof candidate.data?.template_version_name === "string" &&
    /^[A-Za-z0-9_.-]{1,100}$/.test(candidate.data.template_version_name) &&
    Boolean(
      candidate.data.template_variable &&
      typeof candidate.data.template_variable === "object" &&
      !Array.isArray(candidate.data.template_variable)
    ) &&
    Object.values(candidate.data.template_variable).every(
      (item) => typeof item === "string" || (typeof item === "number" && Number.isFinite(item))
    ) &&
    candidate.fallback?.schema === "2.0"
  )
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
