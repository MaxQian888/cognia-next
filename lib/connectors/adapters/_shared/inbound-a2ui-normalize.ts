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
      const url = str(value.url)
      if (!url) return null
      const alt = str(value.alt)
      const width = num(value.width)
      const height = num(value.height)
      return {
        kind: "image",
        url,
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
        ...(actionId ? { actionId } : {}),
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
 * Rebuild `value` as a well-formed block, dropping every node that does not
 * match the vocabulary. Returns null when nothing renderable is left.
 */
export function sanitizeInboundA2UIBlock(value: unknown): InboundA2UIBlock | null {
  if (!isRecord(value)) return null
  const source = str(value.source) as InboundA2UIBlock["source"] | undefined
  if (!source || !SOURCES.has(source)) return null
  const body = sanitizeChildren(value.body, 0, { remaining: MAX_INBOUND_A2UI_NODES })
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
    if (node.kind === "image") into.imageUrls.add(node.url)
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
  parts: readonly unknown[]
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
    const text = part.text.replace(MEDIA_MARKER, (_m, kind: string, ref: string) => {
      const seen = kind === "image" ? media.imageUrls.has(ref) : media.linkLabels.has(ref)
      if (!seen) uncovered = true
      return " "
    })
    if (uncovered) return false
    const needle = displayKey(text)
    if (needle && !prose.includes(needle)) return false
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
