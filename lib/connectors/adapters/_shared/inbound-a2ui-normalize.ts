/**
 * Shape guard and text helpers for persisted `InboundA2UIBlock`s.
 *
 * A block is built by a best-effort mapper from untrusted platform JSON and
 * then lives in `StoredMessage.metadata.inboundA2UI`, where every chat
 * renderer reads it. The mapper's `try/catch` only contains a throw while the
 * block is being built; a structurally wrong block (a missing `body`, a null
 * node, an object where a string belongs) would otherwise throw later, inside
 * React, and take the whole conversation pane with it. `sanitizeInboundA2UIBlock`
 * is therefore applied twice: when the block is projected, and again before
 * a stored row is rendered (rows written before this guard existed).
 *
 * The text helpers serve the two places that need a block's prose: a text
 * mirror for messages whose only content is a card (Lark interactive), and
 * the renderer's decision to hide the plain-text fallback parts when the
 * rich block already shows the same content.
 */

import { escapeMarkdown, markdownLinkDestination } from "./inbound-markdown"
import type { InboundA2UIBlock, InboundA2UINode } from "./inbound-a2ui-types"
import type { MessageSegment } from "@/types/connectors/segment"
import { segmentsToPlainText } from "@/types/connectors/segment"

/** Nesting deeper than any real card; bounds recursion on hostile input. */
export const MAX_INBOUND_A2UI_DEPTH = 12
/** Upper bound on nodes kept per block. */
export const MAX_INBOUND_A2UI_NODES = 1000

const SOURCES: ReadonlySet<InboundA2UIBlock["source"]> = new Set([
  "slack",
  "lark",
  "discord",
  "telegram",
  "onebot",
  "wecom",
  "wechat-personal",
  "wechat-oa",
  "matrix",
  "qq-official",
  "dingtalk",
])

const EMPHASIS = new Set(["muted", "bold", "italic", "code"])
const BUTTON_STYLES = new Set(["primary", "danger", "default"])
const ALERT_TONES = new Set(["info", "warning", "success", "error"])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

function num(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

interface Budget {
  remaining: number
  displayBytes: number
}

function sanitizeChildren(value: unknown, depth: number, budget: Budget): InboundA2UINode[] {
  if (!Array.isArray(value)) return []
  const out: InboundA2UINode[] = []
  for (const child of value) {
    const node = sanitizeNode(child, depth, budget)
    if (node) out.push(node)
  }
  return out
}

function sanitizeNode(value: unknown, depth: number, budget: Budget): InboundA2UINode | null {
  if (!isRecord(value) || depth > MAX_INBOUND_A2UI_DEPTH || budget.remaining <= 0) return null
  budget.remaining -= 1
  switch (value.kind) {
    case "text": {
      const text = str(value.text)
      if (text === undefined) return null
      const emphasis = str(value.emphasis)
      return {
        kind: "text",
        text,
        ...(emphasis && EMPHASIS.has(emphasis)
          ? { emphasis: emphasis as "muted" | "bold" | "italic" | "code" }
          : {}),
        ...(value.format === "markdown" ? { format: "markdown" as const } : {}),
      }
    }
    case "heading": {
      const text = str(value.text)
      if (text === undefined) return null
      const level = value.level === 1 || value.level === 3 ? value.level : 2
      return { kind: "heading", level, text }
    }
    case "image": {
      const originalUrl = str(value.url)
      if (!originalUrl) return null
      // Legacy rows embedded bytes in url before displayUrl existed. Migrate
      // them into the same budget instead of retaining an unbounded payload.
      const inlineUrl = /^data:/i.test(originalUrl)
      const url = inlineUrl ? "inbound-media:legacy" : originalUrl
      const alt = str(value.alt)
      const width = num(value.width)
      const height = num(value.height)
      const displayUrl = str(value.displayUrl) ?? (inlineUrl ? originalUrl : undefined)
      const keepDisplay =
        displayUrl &&
        displayUrl.length <= budget.displayBytes &&
        /^data:image\/(?:png|jpeg|gif|webp|avif|bmp);base64,/i.test(displayUrl)
      if (keepDisplay) budget.displayBytes -= displayUrl.length
      return {
        kind: "image",
        url,
        ...(keepDisplay ? { displayUrl } : {}),
        ...(alt !== undefined ? { alt } : {}),
        ...(width !== undefined ? { width } : {}),
        ...(height !== undefined ? { height } : {}),
      }
    }
    case "link": {
      const href = str(value.href)
      if (!href) return null
      return { kind: "link", href, label: str(value.label) || href }
    }
    case "button": {
      const url = str(value.url)
      const actionId = str(value.actionId)
      const style = str(value.style)
      return {
        kind: "button",
        label: str(value.label) ?? "",
        ...(url ? { url } : {}),
        ...(Object.hasOwn(value, "actionId") ? { actionId: actionId ?? "" } : {}),
        ...(style && BUTTON_STYLES.has(style)
          ? { style: style as "primary" | "danger" | "default" }
          : {}),
      }
    }
    case "divider":
      return { kind: "divider" }
    case "row":
    case "column":
      return { kind: value.kind, children: sanitizeChildren(value.children, depth + 1, budget) }
    case "list":
      return {
        kind: "list",
        children: sanitizeChildren(value.children, depth + 1, budget),
        ...(value.ordered === true ? { ordered: true } : {}),
      }
    case "card": {
      const title = str(value.title)
      const subtitle = str(value.subtitle)
      return {
        kind: "card",
        ...(title !== undefined ? { title } : {}),
        ...(subtitle !== undefined ? { subtitle } : {}),
        children: sanitizeChildren(value.children, depth + 1, budget),
      }
    }
    case "alert": {
      const tone = str(value.tone)
      return {
        kind: "alert",
        tone: tone && ALERT_TONES.has(tone) ? (tone as "info") : "info",
        children: sanitizeChildren(value.children, depth + 1, budget),
      }
    }
    case "mention": {
      const handle = str(value.handle)
      if (!handle) return null
      const resolved = str(value.resolved)
      return { kind: "mention", handle, ...(resolved ? { resolved } : {}) }
    }
    case "reply_context": {
      const replyToMessageId = str(value.replyToMessageId)
      if (!replyToMessageId) return null
      const preview = str(value.preview)
      return { kind: "reply_context", replyToMessageId, ...(preview ? { preview } : {}) }
    }
    case "raw_json": {
      const label = str(value.label)
      return { kind: "raw_json", ...(label ? { label } : {}), payload: value.payload }
    }
    default:
      return null
  }
}

/**
 * Reuse bytes the adapter already cached for presentation only. They live on
 * the message's rich metadata, not replayed parts, and share that row's lifetime.
 * No credentials, fetches or new cache ownership are introduced by rendering.
 */
export function withInboundDisplayMedia(
  block: InboundA2UIBlock | null,
  source: InboundA2UIBlock["source"],
  segments: MessageSegment[]
): InboundA2UIBlock | null {
  if (!SOURCES.has(source) || !Array.isArray(segments)) return block
  let remaining = 7 * 1024 * 1024 // Base64 size for the enrichment pass's 5 MiB limit.
  const media = segments.flatMap((seg, index) => {
    if (!seg || typeof seg !== "object") return []
    if (seg.type !== "image" && seg.type !== "file" && seg.type !== "voice" && seg.type !== "video")
      return []
    if (typeof seg.url !== "string" || (!seg.url && typeof seg.rawUrl !== "string")) return []
    const mime = typeof seg.mimeType === "string" ? seg.mimeType : undefined
    const bytes =
      "dataBase64" in seg && typeof seg.dataBase64 === "string" ? seg.dataBase64 : undefined
    const inlineDisplay =
      /^(?:data:image\/(?:png|jpeg|gif|webp|avif|bmp);base64,|blob:)/i.test(seg.url) &&
      seg.url.length <= remaining
        ? seg.url
        : undefined
    const displayUrl =
      bytes &&
      mime &&
      /^image\/(?:png|jpeg|gif|webp|avif|bmp)$/i.test(mime) &&
      bytes.length <= remaining
        ? `data:${mime};base64,${bytes}`
        : inlineDisplay
    const aliases = new Set(
      [seg.url, seg.rawUrl].filter((url): url is string => typeof url === "string" && Boolean(url))
    )
    if (source === "wechat-personal")
      for (const alias of [...aliases])
        if (!/^(?:data|blob):/i.test(alias)) aliases.add(`wechat-personal-media:${alias}`)
    if (seg.type === "voice" || seg.type === "video")
      for (const alias of [...aliases])
        aliases.add(`${seg.type === "voice" ? "cq-record:" : "cq-video:"}${alias}`)
    // Resolvers may rewrite url to inline bytes. Keep those bytes in one
    // bounded display field, retaining the original reference for dedup/state.
    const ref =
      [seg.url, seg.rawUrl].find(
        (url) => typeof url === "string" && url.length > 0 && !/^(?:data|blob):/i.test(url)
      ) ?? `inbound-media:${index}`
    if (displayUrl) aliases.add(displayUrl) // Matrix may already use the inline bytes.
    aliases.add(`lark-img:${seg.url}`)
    if (seg.url.startsWith("tg://file/")) aliases.add(`telegram-file:${seg.url.slice(10)}`)
    const node: InboundA2UINode =
      seg.type === "image" || (seg.type === "file" && mime?.startsWith("image/"))
        ? {
            kind: "image",
            url:
              source === "wecom" || source === "wechat-personal" ? `${source}-media:${ref}` : ref,
            ...(displayUrl ? { displayUrl } : {}),
            alt: seg.type === "image" ? (seg.alt ?? "") : seg.type === "file" ? seg.name : "",
          }
        : {
            kind: "link",
            href:
              source === "wechat-personal"
                ? `wechat-personal-media:${ref}`
                : !seg.url || /^(?:data|blob):/i.test(seg.url)
                  ? `inbound-media:${index}`
                  : seg.url,
            label:
              seg.type === "file"
                ? seg.name
                : seg.type === "voice"
                  ? seg.transcript || "Voice message"
                  : "Video",
          }
    return [
      {
        aliases,
        node,
        index,
        type: seg.type,
        speech:
          seg.type === "voice" && typeof seg.transcript === "string" ? seg.transcript : undefined,
        inline: /^(?:data|blob):/i.test(seg.url),
      },
    ]
  })
  if (!media.length) return block
  const used = new Set<number>()
  const allocate = (node: InboundA2UINode): InboundA2UINode => {
    if (node.kind !== "image" || !node.displayUrl) return node
    const { displayUrl, ...fallback } = node
    if (displayUrl.length > remaining) return fallback
    remaining -= displayUrl.length
    return node
  }
  const visit = (node: InboundA2UINode): InboundA2UINode => {
    if (node.kind === "image" || node.kind === "link") {
      const matches = (item: (typeof media)[number]) =>
        !used.has(item.index) && item.aliases.has(node.kind === "image" ? node.url : node.href)
      const direct =
        media.find((item) => matches(item) && item.node.kind === node.kind) ??
        media.find((item) => matches(item) && node.kind === "link" && item.type === "file")
      // Sanitizing an old inline URL moves it into displayUrl; retain its
      // source occurrence instead of appending that attachment a second time.
      const legacy = node.kind === "image" && node.url === "inbound-media:legacy"
      const legacyMatches = (item: (typeof media)[number]) =>
        legacy &&
        item.node.kind === "image" &&
        (node.displayUrl ? item.aliases.has(node.displayUrl) : item.inline)
      const found = direct ?? media.find((item) => !used.has(item.index) && legacyMatches(item))
      if (found) {
        used.add(found.index)
        return allocate(
          found.node.kind === "image" && node.kind === "image"
            ? { ...found.node, alt: node.alt || found.node.alt }
            : found.node.kind === "link" && node.kind === "link"
              ? { ...found.node, label: node.label || found.node.label }
              : found.node
        )
      }
    }
    return "children" in node ? { ...node, children: node.children.map(visit) } : node
  }
  const body: InboundA2UINode[] = block
    ? block.body.map(visit)
    : segments.flatMap((seg, index): InboundA2UINode[] => {
        if (!seg || typeof seg !== "object") return []
        if (
          seg.type === "image" ||
          seg.type === "file" ||
          seg.type === "voice" ||
          seg.type === "video"
        ) {
          const item = media.find((candidate) => candidate.index === index)
          if (!item) return []
          // Each occurrence belongs at its original position, including two
          // references to the same attachment on either side of a text run.
          used.add(item.index)
          return [allocate(item.node)]
        }
        if (seg.type === "text") return [{ kind: "text" as const, text: seg.text }]
        if (seg.type === "markdown")
          return [{ kind: "text" as const, text: seg.md, format: "markdown" as const }]
        if (seg.type === "mention") return [{ kind: "mention", handle: seg.userId }]
        if (seg.type === "reply")
          return seg.messageId
            ? [{ kind: "reply_context", replyToMessageId: seg.messageId, preview: seg.snippet }]
            : []
        try {
          const text = segmentsToPlainText([seg])
          return text ? [{ kind: "text", text }] : []
        } catch {
          return []
        }
      })
  for (const item of media) {
    if (used.has(item.index)) continue
    // The WeChat mappers already render recognition as prose. An opaque
    // voice reference adds no playable control, so do not repeat its caption.
    if (
      block &&
      (source === "wechat-personal" || source === "wechat-oa") &&
      item.speech &&
      item.node.kind === "link" &&
      !isNavigableInboundUrl(item.node.href) &&
      body.some((node) => node.kind === "text" && node.text.trim() === item.speech?.trim())
    )
      continue
    body.push(allocate(item.node))
    used.add(item.index)
  }
  return sanitizeInboundA2UIBlock({ ...(block ?? { v: 1 as const, source }), body })
}

/**
 * Rebuild `value` as a well-formed block, dropping every node that does not
 * match the vocabulary. Returns null when nothing renderable is left.
 */
export function sanitizeInboundA2UIBlock(value: unknown): InboundA2UIBlock | null {
  if (!isRecord(value)) return null
  const source = str(value.source) as InboundA2UIBlock["source"] | undefined
  if (!source || !SOURCES.has(source)) return null
  const body = sanitizeChildren(value.body, 0, {
    remaining: MAX_INBOUND_A2UI_NODES,
    displayBytes: 7 * 1024 * 1024,
  })
  if (body.length === 0) return null
  const title = str(value.title)
  return {
    v: 1,
    source,
    ...(title ? { title } : {}),
    body,
    ...(value.raw !== undefined ? { raw: value.raw } : {}),
  }
}

/**
 * True when the block holds nothing but top-level text nodes. The dispatcher
 * drops such a block when its text is the very text the parts hold: a frame
 * around it would add no structure and show the body twice.
 */
export function isTextOnlyInboundA2UIBlock(block: InboundA2UIBlock): boolean {
  return block.body.every((node) => node.kind === "text")
}

function pushLines(
  node: InboundA2UINode,
  lines: string[],
  indent: string,
  markdown: boolean
): void {
  // In Markdown mode, plain text is escaped so a sender's `*`, `<` or
  // `[image: …]` stays literal; Markdown-format text is already Markdown.
  const plain = (text: string) => (markdown ? escapeMarkdown(text) : text)
  switch (node.kind) {
    case "text":
      if (node.text.trim()) {
        lines.push(indent + (node.format === "markdown" ? node.text : plain(node.text)))
      }
      return
    case "heading":
      if (node.text.trim()) lines.push(indent + plain(node.text))
      return
    case "link":
      if (markdown) {
        lines.push(
          `${indent}[${plain(node.label || node.href)}](${markdownLinkDestination(node.href)})`
        )
      } else {
        lines.push(
          indent +
            (node.label && node.label !== node.href ? `${node.label} (${node.href})` : node.href)
        )
      }
      return
    case "button":
      if (node.label.trim()) lines.push(`${indent}${plain(`[${node.label}]`)}`)
      return
    case "mention":
      lines.push(`${indent}@${plain(node.resolved ?? node.handle)}`)
      return
    case "card":
      if (node.title?.trim()) lines.push(indent + plain(node.title))
      if (node.subtitle?.trim()) lines.push(indent + plain(node.subtitle))
      for (const child of node.children) pushLines(child, lines, indent, markdown)
      return
    case "list":
      for (const child of node.children) pushLines(child, lines, `${indent}- `, markdown)
      return
    case "row":
    case "column":
    case "alert":
      for (const child of node.children) pushLines(child, lines, indent, markdown)
      return
    case "image":
    case "divider":
    case "reply_context":
    case "raw_json":
      return
  }
}

/**
 * The block's readable prose, one line per text-bearing node. With
 * `markdown: true` the result is Markdown (plain text escaped, links as
 * links), for a text mirror that is stored and rendered as Markdown.
 */
export function inboundA2UIBlockToPlainText(
  block: InboundA2UIBlock,
  options: { markdown?: boolean } = {}
): string {
  const lines: string[] = []
  for (const node of block.body) pushLines(node, lines, "", options.markdown === true)
  return lines.join("\n")
}

/**
 * Markdown as a reader sees it, for "is this the same prose" comparisons:
 * links reduced to their label, paired emphasis / strike / code delimiters
 * removed, backslash escapes and the common entities decoded, whitespace
 * collapsed. Lone or intra-word markers (`rate_limit`, `~100`, `2*3`) are
 * text, as CommonMark treats them, and are kept. Each pattern stops at the
 * next delimiter character, so a line of unmatched markers stays linear.
 * Only ever compared, never rendered.
 */
export function displayKey(markdown: string): string {
  return markdown
    .replace(/!?\[([^\]\n]*)\]\([^)\s]*\)/g, "$1")
    .replace(/\*\*(?=\S)([^*\n]*?\S)\*\*/g, "$1")
    .replace(/(^|[^\w\\])__(?=\S)([^_\n]*?\S)__(?!\w)/g, "$1$2")
    .replace(/(^|[^\w*\\])\*(?=\S)([^*\n]*?\S)\*(?![\w*])/g, "$1$2")
    .replace(/(^|[^\w\\])_(?=\S)([^_\n]*?\S)_(?!\w)/g, "$1$2")
    .replace(/~~(?=\S)([^~\n]*?\S)~~/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/\\([\\`*_{}[\]()#+\-.!<>~|])/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim()
}

interface BlockMedia {
  imageUrls: Set<string>
  linkLabels: Set<string>
}

function collectMedia(nodes: readonly InboundA2UINode[], into: BlockMedia): BlockMedia {
  for (const node of nodes) {
    if (node.kind === "image")
      into.imageUrls.add(node.url.replace(/^(?:wecom|wechat-personal)-media:/, ""))
    else if (node.kind === "link") into.linkLabels.add(node.label)
    else if ("children" in node) collectMedia(node.children, into)
  }
  return into
}

/** `[image: …]` / `[file: <name>]` markers `inboundEventToStoredParts` writes. */
const MEDIA_MARKER = /\[(image|file): ([^\]\n]*)\]/g

/**
 * True when every text part is already shown by the block, so rendering the
 * parts as well would show the message body twice. A part is covered when
 * its text appears in the block's prose, compared as displayed text
 * (`displayKey`: a Slack fallback "Deploy done" is the same prose as the
 * block's converted "**Deploy** done", but `rate_limit` is not `ratelimit`). Media markers need their own counterpart: each
 * `[image: url]` an image node with that URL, each `[file: name]` a link
 * labelled `name` — an embed's picture or link does not stand in for an
 * attachment. Any part that is not text, or that the block lacks, keeps the
 * parts visible.
 */
export function inboundA2UIBlockCoversParts(
  block: InboundA2UIBlock,
  parts: readonly unknown[],
  displayedReplyPreview?: string
): boolean {
  // The block in Markdown form (plain text escaped) and the parts are both
  // Markdown, so one display key applies to both sides.
  const prose = displayKey(inboundA2UIBlockToPlainText(block, { markdown: true }))
  const media = collectMedia(block.body, { imageUrls: new Set(), linkLabels: new Set() })
  for (const part of parts) {
    if (!isRecord(part)) return false
    if (part.type === "step-start") continue
    if (part.type !== "text" || typeof part.text !== "string") return false
    let uncovered = false
    // Older OneBot rows repeated a generated reply marker before the full
    // body. Remove only that exact prefix when its quote is displayed too.
    const replyMarker =
      displayedReplyPreview === undefined ? undefined : `[reply:${displayedReplyPreview}]`
    const body =
      replyMarker && part.text.trimStart().startsWith(replyMarker)
        ? part.text.trimStart().slice(replyMarker.length)
        : part.text
    const text = body.replace(MEDIA_MARKER, (_m, kind: string, ref: string) => {
      const seen = kind === "image" ? media.imageUrls.has(ref) : media.linkLabels.has(ref)
      if (!seen) uncovered = true
      return " "
    })
    if (uncovered) return false
    const needle = displayKey(text)
    // Stored platform text can be literal prose. Bare URLs such as
    // /__keep__/ must not lose underscores to Markdown emphasis matching.
    const literalNeedle = displayKey(escapeMarkdown(text))
    if (needle && !prose.includes(needle) && !prose.includes(literalNeedle)) return false
  }
  return true
}

/**
 * Whether a media URL from a block can be loaded by the webview. Platform
 * references (`lark-img:`, `telegram-file:`, `mxc://`, …) are keys that need
 * an authenticated download the renderer cannot perform.
 */
export function isDisplayableInboundMediaUrl(url: string): boolean {
  return /^(?:https?:|blob:)/i.test(url) || /^data:image\//i.test(url)
}

/** Whether a link / button target is a web or mail address the app may open. */
export function isNavigableInboundUrl(url: string): boolean {
  return /^(?:https?:|mailto:)/i.test(url)
}
