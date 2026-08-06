"use client"

import { useEffect } from "react"

import { CODESERVER_EVENTS, type CodeServerEditorEvent } from "@/lib/codeserver/client"
import { startNewSession } from "@/lib/chat/start-session"
import { isTauri } from "@/lib/tauri"
import { onTauriEvent } from "@/lib/tauri/events"
import { safeUnlisten } from "@/lib/tauri/safe-unlisten"
import { useChatStore } from "@/stores/chat"
import { useComposerIntentStore } from "@/stores/chat/composer-intent-store"
import type { FileSelectionRef } from "@/types/artifact/artifact"

/**
 * Shape of the `chatContextRequested` event payload pushed by the companion
 * extension's context-menu command handlers.
 */
export interface ChatContextPayload {
  action: "addSelection" | "addFile" | "explain" | "fix" | "review" | "custom"
  path: string
  relativePath: string
  language: string | null
  selection: {
    startLine: number
    startColumn: number
    endLine: number
    endColumn: number
  } | null
  selectedText: string | null
  truncated: boolean
  diagnostics: Array<{ message: string; severity: string; line: number }>
  customPrompt?: string
  customLabel?: string
}

/**
 * Built-in prompt strings mapped to chat context actions. `null` means the
 * action stages context without pre-filling a prompt (the user types their own).
 */
const ACTION_PROMPTS: Record<string, string | null> = {
  addSelection: null,
  addFile: null,
  explain: "Please explain this code.",
  fix: "Please fix the issues in this code.",
  review: "Please review this code for potential bugs and improvements.",
  custom: null,
}

/**
 * Bridges the code-server companion extension's "send to chat" context-menu
 * commands into the app's chat context pipeline.
 *
 * Listens for `chatContextRequested` events pushed by the extension's command
 * handlers, stages a {@link FileSelectionRef} into the chat store, optionally
 * pre-fills the composer with an action-specific prompt, and navigates to the
 * chat page.
 *
 * Follows the same staging pattern as `SelectionToolbarInitializer`: create a
 * context selection, stage an intent, then route the user to the composer.
 *
 * Scoped to `root` when given — a renderer can host two panes, and one
 * project's action should not interfere with the other's.
 */
export function useCodeServerChatBridge(enabled: boolean, root?: string): void {
  useEffect(() => {
    if (!enabled || !isTauri()) return
    let cancelled = false
    let unlisten: (() => void) | null = null

    void onTauriEvent<CodeServerEditorEvent>(CODESERVER_EVENTS.editorEvent, (event) => {
      if (cancelled) return
      if (root !== undefined && event.root !== root) return
      if (event.name !== "chatContextRequested") return

      const payload = event.payload as unknown as ChatContextPayload | null
      if (!payload) return

      void stageContext(payload)
    }).then((fn) => {
      if (cancelled) fn()
      else unlisten = fn
    })

    return () => {
      cancelled = true
      safeUnlisten(unlisten)
    }
  }, [enabled, root])
}

async function stageContext(payload: ChatContextPayload): Promise<void> {
  const chat = useChatStore.getState()
  const current = chat.activeSessionId
  const sessionId = current ?? (await startNewSession()).id

  // Build the FileSelectionRef from the extension payload
  const selection: FileSelectionRef = {
    kind: "file",
    relPath: payload.relativePath,
    title: payload.relativePath,
    snapshot: payload.selectedText ?? "",
    comment: "",
    range: payload.selection
      ? { startLine: payload.selection.startLine, endLine: payload.selection.endLine }
      : undefined,
  }

  // Avoid duplicate staging (same file + same range)
  const alreadyStaged = useChatStore
    .getState()
    .contextSelections.some(
      (s) =>
        s.kind === "file" &&
        s.relPath === selection.relPath &&
        s.range?.startLine === selection.range?.startLine &&
        s.range?.endLine === selection.range?.endLine
    )
  if (!alreadyStaged) {
    useChatStore.getState().addContextSelection(selection)
  }

  // Determine the prompt to stage
  let prompt: string | null = null
  if (payload.action === "custom" && payload.customPrompt) {
    prompt = payload.customPrompt.replace(/\$\{selection\}/g, payload.selectedText ?? "")
  } else {
    prompt = ACTION_PROMPTS[payload.action] ?? null
  }

  // Stage the composer intent (focuses composer, optionally fills prompt)
  const candidateId = `codeserver-${payload.relativePath}-${payload.selection?.startLine ?? 0}`
  useComposerIntentStore.getState().stage(sessionId, {
    candidateId,
    prompt,
  })
}
