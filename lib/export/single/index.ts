// Single-session exporter — picks a format and produces a string + a
// recommended filename. Used by the chat-header trigger and from the
// settings tab's "Quick session export" card.

import type { ChatSession, StoredMessage } from "@/lib/claude/types"
import {
  exportToRichMarkdown,
  exportToRichJSON,
  exportToPlainText,
  type RichExportData,
} from "@/lib/export/text/rich-markdown"
import { exportToBeautifulHtml, type BeautifulHtmlOptions } from "@/lib/export/html/beautiful-html"
import { exportToAnimatedHtml } from "@/lib/export/html/animated-html"
import type { ThemeId, ThemeTokens } from "@/lib/export/html/syntax-themes"

export type SingleExportFormat = "markdown" | "json" | "text" | "html" | "animated"

export interface SingleExportOptions {
  format: SingleExportFormat
  session: ChatSession
  messages: StoredMessage[]
  exportedAt?: Date
  /** HTML / animated formats only. */
  theme?: ThemeId
  customTheme?: ThemeTokens
  includeMetadata?: boolean
  includeTimestamps?: boolean
  includeTokens?: boolean
}

export interface SingleExportResult {
  content: string
  filename: string
  mimeType: string
}

export function renderSingleExport(opts: SingleExportOptions): SingleExportResult {
  const exportedAt = opts.exportedAt ?? new Date()
  const slug = slugify(opts.session.title) || "conversation"

  switch (opts.format) {
    case "markdown": {
      const content = exportToRichMarkdown({
        session: opts.session,
        messages: opts.messages,
        exportedAt,
        includeMetadata: opts.includeMetadata,
        includeTokens: opts.includeTokens,
      } satisfies RichExportData)
      return { content, filename: `${slug}.md`, mimeType: "text/markdown" }
    }
    case "json": {
      const content = exportToRichJSON({
        session: opts.session,
        messages: opts.messages,
        exportedAt,
      })
      return { content, filename: `${slug}.json`, mimeType: "application/json" }
    }
    case "text": {
      const content = exportToPlainText({
        session: opts.session,
        messages: opts.messages,
        exportedAt,
      })
      return { content, filename: `${slug}.txt`, mimeType: "text/plain" }
    }
    case "html": {
      const html = exportToBeautifulHtml({
        session: opts.session,
        messages: opts.messages,
        exportedAt,
        theme: opts.theme,
        customTheme: opts.customTheme,
        includeMetadata: opts.includeMetadata,
        includeTimestamps: opts.includeTimestamps,
      } satisfies BeautifulHtmlOptions)
      return { content: html, filename: `${slug}.html`, mimeType: "text/html" }
    }
    case "animated": {
      const html = exportToAnimatedHtml({
        session: opts.session,
        messages: opts.messages,
        exportedAt,
        theme: opts.theme,
        customTheme: opts.customTheme,
        includeMetadata: opts.includeMetadata,
        includeTimestamps: opts.includeTimestamps,
      })
      return {
        content: html,
        filename: `${slug}.animated.html`,
        mimeType: "text/html",
      }
    }
  }
}

function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
}
