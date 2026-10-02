"use client"

import { useEffect, useRef } from "react"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"

import { buildProblemsContextSelection } from "@/components/editor/project/file-chat-context"
import {
  CODESERVER_EVENTS,
  type CodeServerDiagnosticsHandoff,
  type CodeServerEditorEvent,
} from "@/lib/codeserver/client"
import { startNewSession } from "@/lib/chat/start-session"
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
 * Actions that pre-fill the composer, keyed by their `projectEditor.proIde`
 * translation key. Anything absent stages context without a prompt (the user
 * types their own) — `addSelection`, `addFile`, and `custom`, which carries its
 * own text from the extension.
 *
 * Translated rather than hard-coded: this text lands in the user's composer as
 * visible, editable input, exactly like the selection toolbar's
 * `promptForAction` (`components/providers/initializers/selection-toolbar-initializer.tsx`),
 * which reads the same kind of prompt through the translator.
 */
const ACTION_PROMPT_KEYS: Record<string, string | undefined> = {
  explain: "chatPrompts.explain",
  fix: "chatPrompts.fix",
  review: "chatPrompts.review",
}

/**
 * Bridges the code-server companion extension's "send to chat" commands into
 * the app's chat context pipeline.
 *
 * Listens for `chatContextRequested` (the context-menu actions) and
 * `diagnosticsHandoffRequested` ("Send Problems to Cognia") events pushed by
 * the extension's command handlers, stages {@link FileSelectionRef}s into the
 * chat store, pre-fills the composer where the action implies a prompt, and
 * navigates to the chat page. Problems are staged one chip per file, built by
 * the same `buildProblemsContextSelection` the Monaco Problems panel uses.
 *
 * Follows the same staging pattern as `SelectionToolbarInitializer`: create a
 * context selection, stage an intent, then route the user to the composer.
 *
 * The route is not optional. Only the composer mounted for `sessionId` consumes
 * a staged intent (`components/chat/composer.tsx`), and one of the two Pro IDE
 * hosts is the Agent Team workspace Editor tab — a route with no composer on it
 * at all. Without the push, "Add to Chat" from VS Code staged context into a
 * surface the user could not see and read as a dead menu item.
 *
 * Scoped to `root` when given — a renderer can host two panes, and one
 * project's action should not interfere with the other's.
 */
export function useCodeServerChatBridge(enabled: boolean, root?: string): void {
  const router = useRouter()
  const t = useTranslations("projectEditor.proIde")
  // The next-intl translator isn't a stable reference, so it rides in a ref
  // rather than in the deps — depending on it would tear down and rebuild the
  // listener on every render.
  const tRef = useRef(t)
  useEffect(() => {
    tRef.current = t
  }, [t])

  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    let unlisten: (() => void) | null = null

    void onTauriEvent<CodeServerEditorEvent>(CODESERVER_EVENTS.editorEvent, (event) => {
      if (cancelled) return
      if (root !== undefined && event.root !== root) return
      let staged: Promise<void> | null = null
      if (event.name === "chatContextRequested") {
        const payload = event.payload as unknown as ChatContextPayload | null
        if (payload) staged = stageContext(payload, tRef.current)
      } else if (event.name === "diagnosticsHandoffRequested") {
        const payload = event.payload as unknown as CodeServerDiagnosticsHandoff | null
        if (payload && payload.files.length > 0) staged = stageDiagnostics(payload, tRef.current)
      }
      void staged?.then(() => {
        if (!cancelled) router.push("/")
      })
    }).then((fn) => {
      if (cancelled) fn()
      else unlisten = fn
    })

    return () => {
      cancelled = true
      safeUnlisten(unlisten)
    }
  }, [enabled, root, router])
}

async function stagingSessionId(): Promise<string> {
  return useChatStore.getState().activeSessionId ?? (await startNewSession()).id
}

/**
 * Stage every file's problems as its own chip and ask for a fix. The extension
 * sends errors and warnings only, already 1-based.
 */
async function stageDiagnostics(
  payload: CodeServerDiagnosticsHandoff,
  t: (key: string) => string
): Promise<void> {
  const sessionId = await stagingSessionId()
  for (const file of payload.files) {
    const selection = buildProblemsContextSelection({
      relPath: file.relativePath,
      markers: file.diagnostics.map((diagnostic) => ({
        message: diagnostic.message,
        kind: diagnostic.severity,
        startLineNumber: diagnostic.line,
        startColumn: diagnostic.column,
        endLineNumber: diagnostic.line,
        endColumn: diagnostic.column,
      })),
    })
    const alreadyStaged = useChatStore
      .getState()
      .contextSelections.some(
        (s) =>
          s.kind === "file" && s.relPath === selection.relPath && s.snapshot === selection.snapshot
      )
    if (!alreadyStaged) useChatStore.getState().addContextSelection(selection)
  }
  useComposerIntentStore.getState().stage(sessionId, {
    candidateId: `codeserver-problems-${payload.total}-${payload.files.length}`,
    prompt: t("chatPrompts.fixProblems"),
  })
}

async function stageContext(
  payload: ChatContextPayload,
  t: (key: string) => string
): Promise<void> {
  const sessionId = await stagingSessionId()

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
    const key = ACTION_PROMPT_KEYS[payload.action]
    prompt = key ? t(key) : null
  }

  // Stage the composer intent (focuses composer, optionally fills prompt)
  const candidateId = `codeserver-${payload.relativePath}-${payload.selection?.startLine ?? 0}`
  useComposerIntentStore.getState().stage(sessionId, {
    candidateId,
    prompt,
  })
}
