// ACP-over-stdio sniffer for the external-agent transport.
//
// Some agents (the new wave of ACP-native CLIs) emit A2UI protocol JSON-lines
// directly on their stdout instead of going through MCP tool calls. The
// external-agent stdout reader passes every received line through
// `detectAndDispatchA2uiLine`; if the line parses as an A2UI server message,
// we dispatch it into the store and return `true` so the caller knows it's
// handled (and shouldn't forward the same line as a regular ACP event).
//
// Heuristics are deliberately conservative — only well-formed JSON whose
// `type` is one of the five A2UI server-message kinds counts. Anything that
// looks "a2ui-like" but doesn't pass strict shape checks is left alone.

import { useA2UIStore } from "@/stores/a2ui"
import {
  isCreateSurfaceMessage,
  isUpdateComponentsMessage,
  isUpdateDataModelMessage,
  isDeleteSurfaceMessage,
  isSurfaceReadyMessage,
} from "@/lib/a2ui/parser"
import type { A2UIServerMessage } from "@/types/a2ui/schema"
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
  const candidate = parsed as A2UIServerMessage
  if (
    !isCreateSurfaceMessage(candidate) &&
    !isUpdateComponentsMessage(candidate) &&
    !isUpdateDataModelMessage(candidate) &&
    !isDeleteSurfaceMessage(candidate) &&
    !isSurfaceReadyMessage(candidate)
  ) {
    return false
  }
  try {
    useA2UIStore.getState().processMessage(candidate)
    return true
  } catch (err) {
    loggers.a2ui.error("acp-bridge: dispatch failed", { error: String(err) })
    return false
  }
}
