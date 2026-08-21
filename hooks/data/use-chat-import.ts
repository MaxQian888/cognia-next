"use client"

// State machine for the chat-import flow:
//   idle → loading → preview → applying → done | error
// Symmetric with `useImportFlow` for full backups, but the parsed payload is
// a list of conversations from a third-party export rather than our v3 pkg.

import { useCallback, useEffect, useRef, useState } from "react"
import { pickAndReadFiles } from "@/lib/files/file-bridge"
import { createLogger } from "@cognia/logging"
import {
  applyImported,
  ChatImportUnsupportedError,
  getAcceptedChatImportExtensions,
  importChatExport,
  parseChatImportPayload,
  type ChatImportFormat,
  type ChatImportRejection,
  type ImportedConversation,
} from "@/lib/data/import-registry"

const log = createLogger("data-import")

export type ChatImportFlowState =
  | { status: "idle" }
  | { status: "loading" }
  | {
      status: "preview"
      format: ChatImportFormat
      conversations: ImportedConversation[]
    }
  | {
      status: "applying"
      format: ChatImportFormat
      conversations: ImportedConversation[]
    }
  | { status: "done"; sessionsAdded: number; messagesAdded: number; format: ChatImportFormat }
  | {
      status: "error"
      message: string
      /**
       * Set when the file was recognized but belongs to another flow (an
       * encrypted or plain Cognia backup) or matched nothing. Lets the dialog
       * point at the restore flow instead of printing a generic parse error.
       */
      rejection?: ChatImportRejection
    }

export function useChatImport() {
  const [state, setState] = useState<ChatImportFlowState>({ status: "idle" })
  const stateRef = useRef<ChatImportFlowState>({ status: "idle" })
  useEffect(() => {
    stateRef.current = state
  }, [state])

  const reset = useCallback(() => setState({ status: "idle" }), [])

  const pickFile = useCallback(async () => {
    setState({ status: "loading" })
    try {
      // Derived from the registry, not hard-coded: a plugin importer for a
      // `.zip` / `.jsonl` / `.txt` export was previously unselectable.
      const picked = await pickAndReadFiles({
        filters: [{ name: "Chat export", extensions: getAcceptedChatImportExtensions() }],
      })
      const raw = picked[0]?.content ?? null
      if (raw === null) {
        setState({ status: "idle" })
        return
      }
      // JSON when it parses, raw text otherwise — a bare `JSON.parse` here used
      // to reject every non-JSON export before any importer saw it.
      const result = await importChatExport(parseChatImportPayload(raw))
      setState({
        status: "preview",
        format: result.format,
        conversations: result.conversations,
      })
    } catch (err) {
      log.error("chat-import-pick-failed", { error: err })
      setState({
        status: "error",
        message: err instanceof Error ? err.message : String(err),
        ...(err instanceof ChatImportUnsupportedError ? { rejection: err.reason } : {}),
      })
    }
  }, [])

  /**
   * Returns the write counts on success and `null` on failure, so callers can
   * react without reading `state` — which, right after `await applyAll()`, is
   * still the render-time closure's value (`"preview"`), never `"done"`. The
   * dialog's success toast was gated on exactly that and so never fired.
   */
  const applyAll = useCallback(async (): Promise<{
    sessions: number
    messages: number
  } | null> => {
    const prev = stateRef.current
    if (prev.status !== "preview") return null
    setState({ status: "applying", format: prev.format, conversations: prev.conversations })
    try {
      const counts = await applyImported(prev.conversations)
      setState({
        status: "done",
        format: prev.format,
        sessionsAdded: counts.sessions,
        messagesAdded: counts.messages,
      })
      return counts
    } catch (err) {
      log.error("chat-import-apply-failed", { format: prev.format, error: err })
      setState({ status: "error", message: err instanceof Error ? err.message : String(err) })
      return null
    }
  }, [])

  return { state, pickFile, applyAll, reset }
}
