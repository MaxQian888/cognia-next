"use client"

// State machine for the chat-import flow:
//   idle → loading → preview → applying → done | error
// Symmetric with `useImportFlow` for full backups, but the parsed payload is
// a list of conversations from a third-party export rather than our v3 pkg.

import { useCallback, useEffect, useRef, useState } from "react"
import { pickAndReadFiles } from "@/lib/files/file-bridge"
import { createLogger } from "@/lib/logging"
import {
  applyImported,
  importChatExport,
  type ChatImportFormat,
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
  | { status: "error"; message: string }

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
      const picked = await pickAndReadFiles({
        filters: [{ name: "Chat export", extensions: ["json"] }],
      })
      const raw = picked[0]?.content ?? null
      if (raw === null) {
        setState({ status: "idle" })
        return
      }
      const parsed = JSON.parse(raw)
      const result = await importChatExport(parsed)
      setState({
        status: "preview",
        format: result.format,
        conversations: result.conversations,
      })
    } catch (err) {
      log.error("chat-import-pick-failed", { error: err })
      setState({ status: "error", message: err instanceof Error ? err.message : String(err) })
    }
  }, [])

  const applyAll = useCallback(async () => {
    const prev = stateRef.current
    if (prev.status !== "preview") return
    setState({ status: "applying", format: prev.format, conversations: prev.conversations })
    try {
      const counts = await applyImported(prev.conversations)
      setState({
        status: "done",
        format: prev.format,
        sessionsAdded: counts.sessions,
        messagesAdded: counts.messages,
      })
    } catch (err) {
      log.error("chat-import-apply-failed", { format: prev.format, error: err })
      setState({ status: "error", message: err instanceof Error ? err.message : String(err) })
    }
  }, [])

  return { state, pickFile, applyAll, reset }
}
