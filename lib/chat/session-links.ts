/**
 * What a conversation *produced* that lives behind a URL: files the assistant
 * attached and links it shared in its replies.
 *
 * Pure so the dock's results section, the summary card and the dock's New Tab
 * page can read the same lists without walking the transcript three ways.
 */

import type { UIMessage } from "ai"

import { findUrlSpans } from "@/lib/chat/link-token"

export interface SessionOutputFile {
  url: string
  filename?: string
  mediaType?: string
}

const OUTPUT_PROTOCOLS = new Set(["https:", "http:", "blob:", "data:"])

/**
 * Files the assistant attached to its own messages, deduplicated by URL.
 *
 * Citations, user attachments and tool payload URLs are inputs, not evidence
 * that something was produced, so only assistant `file` parts count.
 */
export function collectAssistantOutputFiles(messages: readonly UIMessage[]): SessionOutputFile[] {
  const files = new Map<string, SessionOutputFile>()
  for (const message of messages) {
    if (message.role !== "assistant") continue
    for (const part of message.parts) {
      if (part.type !== "file") continue
      try {
        const url = new URL(part.url)
        if (!OUTPUT_PROTOCOLS.has(url.protocol)) continue
        files.set(url.href, { url: url.href, filename: part.filename, mediaType: part.mediaType })
      } catch {
        /* Incomplete streaming file parts are not actionable yet. */
      }
    }
  }
  return [...files.values()]
}

/**
 * Links the assistant wrote into its replies, first occurrence first, minus
 * any URL already listed as an output file.
 */
export function collectSharedLinks(
  messages: readonly UIMessage[],
  outputs: readonly SessionOutputFile[] = []
): string[] {
  const links = new Set<string>()
  const outputUrls = new Set(outputs.map((output) => output.url))
  for (const message of messages) {
    if (message.role !== "assistant") continue
    for (const part of message.parts) {
      if (part.type !== "text") continue
      for (const span of findUrlSpans(part.text)) {
        try {
          const url = new URL(span.raw)
          if (!outputUrls.has(url.href)) links.add(url.href)
        } catch {
          /* Incomplete streaming links cannot be opened yet. */
        }
      }
    }
  }
  return [...links]
}
