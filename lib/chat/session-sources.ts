/**
 * What a conversation drew on: cited web pages, documents, files and the tools
 * it called, collected from its messages.
 *
 * Pure (no React) because two surfaces read the same list: the dock's
 * `session-sources` panel and the session summary card. The card only needs
 * the counts and the first few rows, the panel needs everything — one walk
 * keeps their numbers identical.
 */

import type { UIMessage } from "ai"

import { isSourcesPart, type SourcesPartItem } from "@/lib/claude/parts-extensions"

export type SessionSourceKind = "web" | "file" | "other"

export type SessionSourceLabel =
  | "web"
  | "file"
  | "document"
  | "tool"
  | "anthropic"
  | "cogniaWeb"
  | "twinRag"
  | "twinStyle"
  | "agentKnowledge"
  | "memory"
  | "projectKnowledge"
  | "footnote"

export interface SessionSource {
  id: string
  kind: SessionSourceKind
  label: SessionSourceLabel
  title: string
  detail?: string
  url?: string
  /** 1-based position of the message that first produced this source. */
  messageNumber: number
  /** Id of that message, so a surface can jump back to it. */
  messageId: string
}

/** Localised fallbacks for parts that carry no usable title of their own. */
export interface SessionSourceFallbackLabels {
  document: string
  file: string
}

const HTTP_URL_RE = /^https?:\/\//i

function sourceLabel(origin: SourcesPartItem["origin"]): SessionSourceLabel {
  if (origin === "cognia-web") return "cogniaWeb"
  if (origin === "twin-rag") return "twinRag"
  if (origin === "twin-style") return "twinStyle"
  if (origin === "agent-knowledge-base") return "agentKnowledge"
  // The workspace-knowledge origin had no label at all, so the panel asked for
  // `labels.project-knowledge` and rendered the raw key.
  if (origin === "project-knowledge") return "projectKnowledge"
  if (origin === "project-claim" || origin === "project-history") return "memory"
  return origin
}

function sourceKind(source: SourcesPartItem): SessionSourceKind {
  if (
    source.url &&
    HTTP_URL_RE.test(source.url) &&
    (source.origin === "anthropic" ||
      source.origin === "cognia-web" ||
      source.origin === "footnote")
  ) {
    return "web"
  }
  return "other"
}

function safeHostname(url: string): string | undefined {
  try {
    return new URL(url).hostname
  } catch {
    return undefined
  }
}

function filenameFromUrl(url: string): string | undefined {
  if (!HTTP_URL_RE.test(url)) return undefined
  try {
    const name = new URL(url).pathname.split("/").filter(Boolean).at(-1)
    return name ? decodeURIComponent(name) : undefined
  } catch {
    return undefined
  }
}

function compactValue(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined
  if (typeof value === "string") return value.trim() || undefined
  try {
    const serialized = JSON.stringify(value)
    return serialized.length > 240 ? `${serialized.slice(0, 237)}…` : serialized
  } catch {
    return String(value)
  }
}

function toolNameOfPart(part: Record<string, unknown>, type: string): string {
  if (type === "dynamic-tool" && typeof part.toolName === "string") return part.toolName
  return type.startsWith("tool-") ? type.slice("tool-".length) : type
}

/**
 * Every source the conversation used, first occurrence first.
 *
 * A source seen again later keeps its first message (that is where it entered
 * the conversation) but adopts a detail or URL the first sighting lacked.
 */
export function collectSessionSources(
  messages: readonly UIMessage[],
  fallbackLabels: SessionSourceFallbackLabels
): SessionSource[] {
  const collected = new Map<string, SessionSource>()

  const add = (source: SessionSource) => {
    const existing = collected.get(source.id)
    if (!existing) {
      collected.set(source.id, source)
      return
    }
    collected.set(source.id, {
      ...existing,
      detail: existing.detail ?? source.detail,
      url: existing.url ?? source.url,
    })
  }

  messages.forEach((message, messageIndex) => {
    message.parts.forEach((rawPart, partIndex) => {
      const part = rawPart as unknown as Record<string, unknown>
      const type = typeof part.type === "string" ? part.type : ""
      const messageNumber = messageIndex + 1
      const messageId = message.id

      if (type === "source-url" && typeof part.url === "string") {
        const url = part.url
        add({
          id: `web:${url}`,
          kind: "web",
          label: "web",
          title:
            typeof part.title === "string" && part.title.trim()
              ? part.title
              : (safeHostname(url) ?? url),
          detail: safeHostname(url),
          url,
          messageNumber,
          messageId,
        })
        return
      }

      if (type === "source-document") {
        const title =
          (typeof part.filename === "string" && part.filename) ||
          (typeof part.title === "string" && part.title) ||
          (typeof part.sourceId === "string" && part.sourceId) ||
          fallbackLabels.document
        const detail = [part.title, part.mediaType]
          .filter((value): value is string => typeof value === "string" && value !== title)
          .join(" · ")
        add({
          id: `document:${String(part.sourceId ?? title)}`,
          kind: "file",
          label: "document",
          title,
          detail: detail || undefined,
          messageNumber,
          messageId,
        })
        return
      }

      if (type === "file") {
        const url = typeof part.url === "string" ? part.url : undefined
        const mediaType = typeof part.mediaType === "string" ? part.mediaType : undefined
        const title =
          (typeof part.filename === "string" && part.filename) ||
          (url && filenameFromUrl(url)) ||
          mediaType ||
          fallbackLabels.file
        const externalUrl = url && HTTP_URL_RE.test(url) ? url : undefined
        add({
          id: externalUrl
            ? `file:${externalUrl}`
            : `file:${title}:${mediaType ?? ""}:${message.id}:${partIndex}`,
          kind: "file",
          label: "file",
          title,
          detail: mediaType,
          url: externalUrl,
          messageNumber,
          messageId,
        })
        return
      }

      if (isSourcesPart(part)) {
        part.sources.forEach((source) => {
          const kind = sourceKind(source)
          const url = source.url && HTTP_URL_RE.test(source.url) ? source.url : undefined
          const detail = [url ? safeHostname(url) : undefined, source.snippet]
            .filter(Boolean)
            .join(" · ")
          add({
            id: kind === "web" && url ? `web:${url}` : `other:${source.origin}:${source.id}`,
            kind,
            label: sourceLabel(source.origin),
            title: source.title,
            detail: detail || undefined,
            url,
            messageNumber,
            messageId,
          })
        })
        return
      }

      if (type === "dynamic-tool" || type.startsWith("tool-")) {
        const toolName = toolNameOfPart(part, type)
        add({
          id: `tool:${String(part.toolCallId ?? `${message.id}:${partIndex}`)}`,
          kind: "other",
          label: "tool",
          title: toolName,
          detail: compactValue(part.input),
          messageNumber,
          messageId,
        })
      }
    })
  })

  return [...collected.values()]
}

/** One row of the summary card's source list: a label and how often it was used. */
export interface SessionSourceGroup {
  label: SessionSourceLabel
  count: number
  /** Where the label first appeared. */
  messageId: string
}

/**
 * Sources grouped by label, most-used first, for the summary card.
 *
 * Ties keep first-appearance order, so a list does not reshuffle while a
 * reply streams in more of the same.
 */
export function groupSessionSourcesByLabel(
  sources: readonly SessionSource[]
): SessionSourceGroup[] {
  const groups = new Map<SessionSourceLabel, SessionSourceGroup>()
  for (const source of sources) {
    const group = groups.get(source.label)
    if (group) group.count += 1
    else groups.set(source.label, { label: source.label, count: 1, messageId: source.messageId })
  }
  return [...groups.values()].sort((a, b) => b.count - a.count)
}
