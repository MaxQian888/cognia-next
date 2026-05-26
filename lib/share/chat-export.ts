// Bridges the existing single-export renderer to a share payload: fetch the
// session's messages, render in the chosen format, wrap as a SharePayload.
// Reuses `renderSingleExport` verbatim so shared output matches downloaded output.

import { renderSingleExport, type SingleExportFormat } from "@/lib/export/single"
import { getDb } from "@/lib/db/schema"
import { chatExportPayload } from "./payload"
import type { SharePayload } from "./types"
import type { ChatSession } from "@/lib/claude/types"
import type { ThemeId, ThemeTokens } from "@/lib/export/html/syntax-themes"

export interface BuildChatShareArgs {
  format: SingleExportFormat
  session: ChatSession
  theme?: ThemeId
  customTheme?: ThemeTokens
  includeMetadata?: boolean
  includeTimestamps?: boolean
  includeTokens?: boolean
}

export async function buildChatSharePayload(args: BuildChatShareArgs): Promise<SharePayload> {
  const messages = await getDb()
    .messages.where("sessionId")
    .equals(args.session.id)
    .sortBy("createdAt")
  const rendered = renderSingleExport({
    format: args.format,
    session: args.session,
    messages,
    theme: args.theme,
    customTheme: args.customTheme,
    includeMetadata: args.includeMetadata,
    includeTimestamps: args.includeTimestamps,
    includeTokens: args.includeTokens,
  })
  return chatExportPayload(rendered, args.format, args.session.title || "Conversation")
}
