// ACP-over-stdio sniffer for the external-agent transport.
//
// Some agents (the new wave of ACP-native CLIs) emit A2UI protocol JSON-lines
// directly on their stdout instead of going through MCP tool calls. The
// transport integrations may pass received lines through
// `detectAndDispatchA2uiLine`; no production transport currently invokes it.
// If a line parses as an A2UI server message,
// we dispatch it into the store and return `true` so the caller knows it's
// handled (and shouldn't forward the same line as a regular ACP event).
//
// Heuristics are deliberately conservative — only well-formed JSON whose
// `type` is one of the five A2UI server-message kinds counts. Anything that
// looks "a2ui-like" but doesn't pass strict shape checks is left alone.

import { useA2UIStore } from "@/stores/a2ui"
import { parseA2UIMessage } from "@/lib/a2ui/parser"
import { loggers } from "@cognia/logging"

/** Returns true if the line was recognised + dispatched. */
export function detectAndDispatchA2uiLine(line: string): boolean {
  const trimmed = line.trim()
  if (!trimmed.startsWith("{")) return false
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return false
  }
  const candidate = parseA2UIMessage(parsed)
  if (!candidate) return false
  try {
    useA2UIStore.getState().processMessage(candidate)
    return true
  } catch (err) {
    loggers.a2ui.error("acp-bridge: dispatch failed", { error: String(err) })
    return false
  }
}
