"use client"

/**
 * Canvas Panel — the central editor surface for the Canvas workspace.
 *
 * cognia-next's slimmed-down implementation of Cognia's canvas-panel.
 * Wraps `@monaco-editor/react`, layers the AI action toolbar on top,
 * and surfaces the markdown format toolbar for "text"-typed
 * documents. Side-panels (Suggestions / History / Comments /
 * Collaboration / Execution) are siblings — see
 * `components/canvas/canvas-side-panels.tsx`.
 */

import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import dynamic from "next/dynamic"
import { nanoid } from "nanoid"
import type { editor as MonacoEditor } from "monaco-editor"
import { useTranslations } from "next-intl"
import {
  Save,
  MoreHorizontal,
  Search,
  Plus,
  FileCode,
  FileText,
  X,
  Copy,
  Trash2,
  Edit2,
  Gauge as GaugeIcon,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia } from "@/components/ui/empty"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { ScrollArea, ScrollBar } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import type { CanvasDocument } from "@/types/artifact/artifact"
import { useCanvasMonacoSetup } from "@/hooks/canvas/use-canvas-monaco-setup"
import {
  useCanvasDocumentSummaries,
  type CanvasDocumentSummary,
} from "@/hooks/canvas/use-canvas-document-summaries"
import { useDebouncedCallback } from "@/hooks/workflow/use-debounced-callback"
import { CANVAS_EDIT_COMMIT_DEBOUNCE_MS } from "@/lib/canvas/constants"
import { useSharedCanvasActions } from "./canvas-actions-context"
import { useCanvasSuggestions } from "@/hooks/canvas/use-canvas-suggestions"
import { useAutoSuggestions } from "@/hooks/canvas/use-auto-suggestions"
import { useCanvasKeyboardShortcuts } from "@/hooks/canvas/use-canvas-keyboard-shortcuts"
import { useCanvasFeatureFlag } from "@/hooks/canvas/use-canvas-feature-flag"
import { useCanvasSettingsStore } from "@/stores/canvas/canvas-settings-store"
import type { CanvasActionType } from "@/lib/ai/generation/canvas-actions"
import { RenameDialog } from "./rename-dialog"
import { CanvasDeleteDocumentDialog } from "./canvas-delete-document-dialog"
import type { FormatAction } from "@/components/document/document-format-toolbar"
import { FORMAT_ACTION_MAP } from "@/lib/canvas/constants"
import { PluginExtensionSlot } from "@/components/plugins/plugin-extension-slot"
import { CanvasInlineCommand } from "./canvas-inline-command"
import { LightCodeEditor } from "@/components/editor/light-code-editor"
import { LspServerHint } from "@/components/editor/lsp-server-hint"
import { MonacoDiagnosticsBar } from "@/components/editor/monaco-diagnostics-bar"
import { editorLanguageFromMonacoId } from "@/components/editor/editor-language"
import { useIsMobile } from "@/hooks/ui/use-mobile"
import { ResizableHandle, ResizablePanel, ResizablePanelGroup } from "@/components/ui/resizable"
import { useCanvasLayoutStore } from "@/stores/canvas/canvas-layout-store"
import { isCanvasDocumentPreviewable } from "@/lib/canvas/artifact-projection"
import type {
  CanvasActionEntryPoint,
  CanvasActionHistoryEntry,
  CanvasWorkbenchActionType,
} from "@/types/artifact/artifact"
import { CanvasPreviewPane } from "./canvas-preview-pane"
import { CanvasReviewView } from "./canvas-review-view"
import { CanvasViewModeToggle } from "./canvas-view-mode-toggle"
import { CANVAS_GOTO_LINE_EVENT, type CanvasGotoLineDetail } from "./canvas-outline-panel"
import { requestCanvasExecute } from "./canvas-execute-event"

const MonacoEditorView = dynamic(() => import("@monaco-editor/react").then((mod) => mod.default), {
  ssr: false,
  loading: () => <EditorLoading />,
})

interface CanvasPanelProps {
  className?: string
}

function EditorLoading() {
  const t = useTranslations("canvas")
  return (
    <div className="flex h-full items-center justify-center bg-muted/20 text-sm text-muted-foreground">
      <Spinner className="mr-2 size-4" />
      {t("loadingEditor")}
    </div>
  )
}

export function CanvasPanel({ className }: CanvasPanelProps) {
  const t = useTranslations("canvas")
  // Two narrow reads instead of one wide one. `s.canvasDocuments` changes
  // identity on every keystroke, so subscribing to the map re-rendered this
  // whole subtree — Monaco wrapper, side panels, outline, review view — once per
  // character. The rail and tabs only need identity + label; the editor needs
  // exactly one document.
  const documents = useCanvasDocumentSummaries()
  const activeId = useArtifactStore((s) => s.activeCanvasId)
  const setActive = useArtifactStore((s) => s.setActiveCanvas)
  const updateDoc = useArtifactStore((s) => s.updateCanvasDocument)
  const create = useArtifactStore((s) => s.createCanvasDocument)
  const remove = useArtifactStore((s) => s.deleteCanvasDocument)
  const saveVersion = useArtifactStore((s) => s.saveCanvasVersion)
  const getCanvasVersions = useArtifactStore((s) => s.getCanvasVersions)
  const updateWorkbench = useArtifactStore((s) => s.updateCanvasWorkbench)
  const appendActionHistory = useArtifactStore((s) => s.appendCanvasActionHistory)
  const updateActionHistoryEntry = useArtifactStore((s) => s.updateCanvasActionHistoryEntry)
  const inlineCommandOpen = useArtifactStore((s) =>
    Boolean(activeId && s.canvasDocuments[activeId]?.aiWorkbench?.isInlineCommandOpen)
  )
  const proposeCanvasReview = useArtifactStore((s) => s.proposeCanvasReview)
  const previewMode = useCanvasLayoutStore((s) => s.previewMode)
  // The tab strip lists OPEN documents, not every document in the workspace.
  // Closing removes a tab and nothing else; deleting is the confirmed action
  // below. Before this split the X did both.
  const openDocIds = useCanvasLayoutStore((s) => s.openDocIds)
  const openDocument = useCanvasLayoutStore((s) => s.openDocument)
  const closeDocument = useCanvasLayoutStore((s) => s.closeDocument)
  const [deleteCandidateId, setDeleteCandidateId] = useState<string | null>(null)
  const pendingReview = useArtifactStore((s) =>
    activeId ? (s.pendingReviews[activeId] ?? null) : null
  )

  const activeDoc = useArtifactStore((s) =>
    activeId ? ((s.canvasDocuments[activeId] as CanvasDocument | undefined) ?? null) : null
  )

  // Every path that focuses a document (the rail, `revealCanvasDocument`, the
  // `canvas_open` tool, a plugin) goes through `activeCanvasId`, so opening the
  // tab here covers all of them without each having to remember to.
  useEffect(() => {
    if (activeId) openDocument(activeId)
  }, [activeId, openDocument])

  // Tabs, in tab order, restricted to documents this workspace still has. The
  // active one is always included: it is open by definition, and the effect
  // above lands a beat later on first activation.
  const openDocuments = useMemo(() => {
    const byId = new Map(documents.map((doc) => [doc.id, doc]))
    const ordered = openDocIds.map((id) => byId.get(id)).filter((doc) => doc !== undefined)
    if (activeId && byId.has(activeId) && !ordered.some((doc) => doc.id === activeId)) {
      ordered.push(byId.get(activeId)!)
    }
    return ordered
  }, [documents, openDocIds, activeId])

  const handleCloseDocument = useCallback(
    (id: string) => {
      const next = closeDocument(id)
      if (activeId === id) setActive(next)
    },
    [activeId, closeDocument, setActive]
  )
  // The last content this component put INTO the store. Anything else arriving
  // on `activeDoc.content` came from outside (AI action, review accept, version
  // restore) and must cancel a pending keystroke batch rather than race it.
  const lastCommittedRef = useRef<string | null>(activeDoc?.content ?? null)
  /** The newest value the editor has produced, committed or not. */
  const pendingValueRef = useRef<string | null>(null)

  // Committing straight from Monaco's onChange put four things on the critical
  // path of every keystroke: a store write, a whole-panel re-render, a
  // synchronous full-state localStorage write, and an IndexedDB transaction
  // that re-put the entire canvas corpus. The buffer Monaco holds is already
  // authoritative between commits, so the write can wait for a typing pause.
  const updateDocRef = useRef(updateDoc)
  useEffect(() => {
    updateDocRef.current = updateDoc
  }, [updateDoc])

  const commitEditorContent = useCallback(
    (value: string) => {
      if (!activeId) return
      pendingValueRef.current = null
      lastCommittedRef.current = value
      updateDoc(activeId, { content: value, updatedAt: new Date() })
    },
    [activeId, updateDoc]
  )
  // `call` / `flush` / `cancel` are stable across renders (the hook holds `fn`
  // in a ref), so they can be used directly in effects and dependency arrays.
  const {
    call: commitEdit,
    flush: flushCommit,
    cancel: cancelCommit,
  } = useDebouncedCallback(commitEditorContent, CANVAS_EDIT_COMMIT_DEBOUNCE_MS)

  const handleEditorChange = useCallback(
    (value: string | undefined) => {
      if (!activeId) return
      pendingValueRef.current = value ?? ""
      commitEdit(value ?? "")
    },
    [activeId, commitEdit]
  )

  // Flush on document switch and on unmount.
  //
  // This does NOT call the hook's `flush()`: the hook registers its own unmount
  // cleanup, which CANCELS, and React runs cleanups in effect-declaration order
  // — the hook's is declared first, so by the time this one runs there is
  // nothing left to flush. Writing the captured value directly is what actually
  // saves the last characters typed before the panel closes.
  useEffect(() => {
    const idAtMount = activeId
    return () => {
      const pending = pendingValueRef.current
      pendingValueRef.current = null
      if (!idAtMount || pending === null || pending === lastCommittedRef.current) return
      cancelCommit()
      lastCommittedRef.current = pending
      updateDocRef.current(idAtMount, { content: pending, updatedAt: new Date() })
    }
  }, [activeId, cancelCommit])

  // Cancel — not flush — when the content changes from outside: an AI action, a
  // review being accepted, a version restore. Monaco is controlled on
  // `activeDoc.content`, so a pending keystroke batch landing after one of
  // those would overwrite it with the pre-action buffer.
  useEffect(() => {
    const incoming = activeDoc?.content
    if (incoming === undefined) return
    if (incoming === lastCommittedRef.current) return
    lastCommittedRef.current = incoming
    pendingValueRef.current = null
    cancelCommit()
  }, [activeDoc?.content, cancelCommit])

  const monacoSetup = useCanvasMonacoSetup({
    documentId: activeId ?? undefined,
    language: activeDoc?.language,
    initialContent: activeDoc?.content ?? "",
    // Live content, not just the mount value: the profile has to escalate
    // when a user pastes a large file into a document that opened small.
    content: activeDoc?.content ?? "",
  })
  const performanceProfile = monacoSetup.performanceProfile

  const actions = useSharedCanvasActions()
  const suggestions = useCanvasSuggestions()
  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null)
  const editorContainerRef = useRef<HTMLDivElement | null>(null)
  // Mobile renders the CodeMirror light editor instead of Monaco (no LSP
  // workbench, no worker assets); every editorRef consumer below falls back
  // to whole-document semantics when the Monaco ref is absent.
  const isMobile = useIsMobile()
  // Feature-flag gate: `canvas.aiWorkbench.v1` (env / localStorage override).
  // When off, the AI action toolbar items and the Ctrl+K palette are hidden.
  const aiWorkbenchEnabled = useCanvasFeatureFlag("canvas.aiWorkbench.v1")
  const accessibility = useCanvasSettingsStore((s) => s.settings.accessibility)
  const editorSettings = useCanvasSettingsStore((s) => s.settings.editor)
  // Single-writer Monaco theme id, resolved inside the setup hook (the hook is
  // the only caller of `monaco.editor.setTheme`). Passing it to the `theme` prop
  // too just avoids a first-paint flash — both agree, so the editor now tracks
  // the app palette / light-dark / high-contrast state instead of fighting it.
  const resolvedMonacoTheme = monacoSetup.resolvedThemeId

  // Center-pane presentation. Non-previewable code documents can only show the
  // editor, so "split"/"preview" collapse to "code" for them.
  const previewable = activeDoc ? isCanvasDocumentPreviewable(activeDoc) : false
  const reviewing = Boolean(activeDoc && pendingReview)
  const effectiveMode = previewable ? previewMode : "code"
  // The desktop Monaco editor is only mounted in code/split (not preview) and
  // never during a review; when it isn't mounted, drop the stale handle so
  // every editorRef consumer takes its whole-document fallback path (and we
  // never call getValue() on a disposed editor from the auto-save loop).
  const editorMounted = Boolean(activeDoc) && !reviewing && !isMobile && effectiveMode !== "preview"
  useEffect(() => {
    if (!editorMounted) editorRef.current = null
  }, [editorMounted])

  // Outline → editor navigation: the outline panel (a sibling in the right rail)
  // dispatches `canvas-goto-line`; reveal + focus the line in Monaco. Mirrors the
  // existing `canvas-action` / `canvas-save` window-event bus.
  useEffect(() => {
    const handler = (ev: Event) => {
      const detail = (ev as CustomEvent<CanvasGotoLineDetail>).detail
      if (!detail || typeof detail.line !== "number") return
      const editor = editorRef.current
      if (!editor) return
      editor.revealLineInCenter(detail.line)
      editor.setPosition({ lineNumber: detail.line, column: 1 })
      editor.focus()
    }
    window.addEventListener(CANVAS_GOTO_LINE_EVENT, handler as EventListener)
    return () => window.removeEventListener(CANVAS_GOTO_LINE_EVENT, handler as EventListener)
  }, [])

  // Wire keyboard shortcuts: Cmd+R/F/I/E/S/X dispatch CustomEvents
  // that the toolbar listens for. The keybinding store remaps these
  // through Settings → Canvas → Keybindings.
  useCanvasKeyboardShortcuts({
    isActive: true,
    isProcessing: actions.running,
    hasActiveDocument: Boolean(activeDoc),
  })

  // (Keyboard event → runAction routing is wired below, after
  // runAction is defined; we forward through a ref so a single window
  // listener stays bound but always calls the freshest closure.)
  const runActionRef = useRef<
    | ((
        t: CanvasActionType,
        opts?: { targetLanguage?: string; prompt?: string; proposalFirst?: boolean }
      ) => Promise<void>)
    | null
  >(null)
  const handleFormatRef = useRef<(action: FormatAction) => void>(() => undefined)
  useEffect(() => {
    const handler = (ev: Event) => {
      const detail = (
        ev as CustomEvent<{
          type?: string
          targetLanguage?: string
          prompt?: string
          proposalFirst?: boolean
        }>
      ).detail
      if (!detail || !detail.type) return
      void runActionRef.current?.(detail.type as CanvasActionType, {
        targetLanguage: detail.targetLanguage,
        prompt: detail.prompt,
        proposalFirst: detail.proposalFirst,
      })
    }
    window.addEventListener("canvas-action", handler as EventListener)
    return () => window.removeEventListener("canvas-action", handler as EventListener)
  }, [])

  useEffect(() => {
    const handler = (ev: Event) => {
      const action = (ev as CustomEvent<{ action?: FormatAction }>).detail?.action
      if (action) handleFormatRef.current?.(action)
    }
    window.addEventListener("canvas-format", handler as EventListener)
    return () => window.removeEventListener("canvas-format", handler as EventListener)
  }, [])

  // Stamp the resolved tier onto the document. `CanvasEditorContext.performanceMode`
  // has been declared since the type landed and never had a writer; plugins read
  // the editor context through `lib/plugin/api/canvas-api.ts`, and a plugin that
  // wants to skip its own whole-document pass on a 200k-char file needs to be able
  // to see the same answer the editor acted on. Only writes on a tier *change*, so
  // it never joins the per-keystroke traffic.
  const stampedModeRef = useRef<string | null>(null)
  useEffect(() => {
    if (!activeId) {
      stampedModeRef.current = null
      return
    }
    const key = `${activeId}:${performanceProfile.mode}`
    if (stampedModeRef.current === key) return
    stampedModeRef.current = key
    const doc = useArtifactStore.getState().canvasDocuments[activeId]
    if (!doc || doc.editorContext?.performanceMode === performanceProfile.mode) return
    updateDoc(activeId, {
      editorContext: { ...doc.editorContext, performanceMode: performanceProfile.mode },
    })
  }, [activeId, performanceProfile.mode, updateDoc])

  // Ctrl+S / Ctrl+Shift+S arrive as `canvas-save` from the keybinding handler
  // (the panel owns the editor buffer, so the save lives here). "manual" flushes
  // the live buffer into the store; "version" additionally snapshots a version.
  useEffect(() => {
    const handler = (ev: Event) => {
      if (!activeId) return
      const mode = (ev as CustomEvent<{ mode?: string }>).detail?.mode
      // Flush first so the pending debounce cannot land after this write and
      // re-commit the same content a beat later.
      flushCommit()
      const content = editorRef.current?.getValue()
      if (typeof content === "string") updateDoc(activeId, { content, updatedAt: new Date() })
      if (mode === "version") saveVersion(activeId, "manual")
    }
    window.addEventListener("canvas-save", handler as EventListener)
    return () => window.removeEventListener("canvas-save", handler as EventListener)
  }, [activeId, updateDoc, saveVersion, flushCommit])

  // Lightweight auto-save: every `autoSaveInterval` seconds, push the
  // editor's current value into the artifact store and write a snapshot
  // marked as auto-save. The artifact-store handles version retention;
  // the dexie-bridge mirrors the snapshot to IndexedDB for backup.
  const autoSaveSeconds = useCanvasSettingsStore((s) => s.settings.version.autoSaveInterval)
  useEffect(() => {
    if (!activeId) return
    const timer = setInterval(
      () => {
        // Monaco exposes the live buffer; the light editor (mobile) pushes
        // every edit into the store, so the store copy is authoritative there.
        // The interval reads the live buffer, so a pending commit is redundant
        // work at best and a duplicate write at worst.
        flushCommit()
        const content =
          editorRef.current?.getValue() ??
          (useArtifactStore.getState().canvasDocuments[activeId] as CanvasDocument | undefined)
            ?.content
        if (typeof content !== "string") return
        updateDoc(activeId, { content, updatedAt: new Date() })
        saveVersion(activeId, "auto-save")
      },
      Math.max(10, autoSaveSeconds) * 1000
    )
    return () => clearInterval(timer)
  }, [activeId, autoSaveSeconds, saveVersion, updateDoc, flushCommit])

  // Monaco flex-shrink fix: Monaco's internal div sets a fixed pixel width
  // via JS that prevents the flex container from shrinking (microsoft/monaco-editor#3393).
  // A ResizeObserver on the container explicitly calls editor.layout() to
  // override Monaco's stale inline dimensions when the panel is resized.
  // The 60ms trailing debounce coalesces the burst of observer ticks fired
  // while a user drags a ResizableHandle — without it, Monaco rerenders on
  // every animation frame and visibly stutters.
  useEffect(() => {
    const container = editorContainerRef.current
    if (!container || typeof ResizeObserver === "undefined") return
    let pending: ReturnType<typeof setTimeout> | null = null
    const observer = new ResizeObserver(() => {
      if (pending) clearTimeout(pending)
      pending = setTimeout(() => {
        pending = null
        editorRef.current?.layout()
      }, 60)
    })
    observer.observe(container)
    return () => {
      if (pending) clearTimeout(pending)
      observer.disconnect()
    }
  }, [])

  const insertAtSelection = useCallback((text: string) => {
    const editor = editorRef.current
    if (!editor) return
    const sel = editor.getSelection()
    if (!sel) {
      const pos = editor.getPosition()
      if (!pos) return
      editor.executeEdits("canvas-format", [
        {
          range: {
            startLineNumber: pos.lineNumber,
            startColumn: pos.column,
            endLineNumber: pos.lineNumber,
            endColumn: pos.column,
          },
          text,
          forceMoveMarkers: true,
        },
      ])
    } else {
      editor.executeEdits("canvas-format", [{ range: sel, text, forceMoveMarkers: true }])
    }
    editor.focus()
  }, [])

  const handleFormat = useCallback(
    (action: FormatAction) => {
      const mapping = FORMAT_ACTION_MAP[action]
      if (!mapping) return
      const editor = editorRef.current
      if (!editor) {
        // Light-editor (mobile) fallback: no selection API — append the
        // format scaffold to the document end instead of silently no-oping.
        if (!activeDoc) return
        updateDoc(activeDoc.id, {
          content: `${activeDoc.content}${mapping.prefix}${mapping.suffix}`,
          updatedAt: new Date(),
        })
        return
      }
      const sel = editor.getSelection()
      const selectionText =
        sel && !sel.isEmpty() ? (editor.getModel()?.getValueInRange(sel) ?? "") : ""
      insertAtSelection(`${mapping.prefix}${selectionText}${mapping.suffix}`)
    },
    [insertAtSelection, activeDoc, updateDoc]
  )
  useEffect(() => {
    handleFormatRef.current = handleFormat
  }, [handleFormat])

  const runAction = useCallback(
    async (
      actionType: CanvasActionType,
      opts: {
        targetLanguage?: string
        prompt?: string
        proposalFirst?: boolean
        entryPoint?: CanvasActionEntryPoint
      } = {}
    ) => {
      if (!activeDoc) return
      // An AI action reads `activeDoc.content`, which is the STORE's copy. Flush
      // so it sees what the user actually typed rather than the state as of the
      // last pause.
      flushCommit()
      const editor = editorRef.current
      const sel = editor?.getSelection()
      const selectionText =
        editor && sel && !sel.isEmpty()
          ? (editor.getModel()?.getValueInRange(sel) ?? undefined)
          : undefined

      // Every run is recorded before it starts, so a failure is still visible
      // in the history rather than vanishing with the request.
      const attachments = activeDoc.aiWorkbench?.attachments ?? []
      const historyId = nanoid()
      const historyEntry: CanvasActionHistoryEntry = {
        id: historyId,
        requestId: historyId,
        actionType: actionType as CanvasWorkbenchActionType,
        prompt: opts.prompt ?? activeDoc.aiWorkbench?.promptDraft ?? "",
        scope: selectionText ? "selection" : "document",
        entryPoint: opts.entryPoint ?? "toolbar",
        createdAt: new Date(),
        status: "pending-review",
        attachmentSummary: attachments.map((attachment) => attachment.label),
        ...(attachments.length > 0 ? { attachments } : {}),
      }
      appendActionHistory(activeDoc.id, historyEntry)
      const settleHistory = (patch: Partial<CanvasActionHistoryEntry>) =>
        updateActionHistoryEntry(activeDoc.id, historyId, patch)

      // `run` used to ask a model to *imagine* executing the code and print
      // what it thought would happen, next to an execution panel that actually
      // runs it. It now delegates to that panel.
      if (actionType === "run") {
        requestCanvasExecute(activeDoc.id)
        settleHistory({ status: "completed" })
        return
      }

      // `review` used to return prose that nothing rendered. It produces
      // anchored suggestions now, which the Suggestions panel can accept or
      // reject one at a time.
      if (actionType === "review") {
        const position = editor?.getPosition() ?? null
        const findings = await suggestions.generate(
          {
            documentId: activeDoc.id,
            language: activeDoc.language,
            content: activeDoc.content,
            cursorLine: position?.lineNumber,
            cursorColumn: position?.column,
            selectionText,
          },
          { mode: "review" }
        )
        settleHistory({ status: findings.length > 0 ? "pending-review" : "completed" })
        return
      }

      let result: string
      try {
        result = await actions.run({
          actionType,
          content: activeDoc.content,
          language: activeDoc.language,
          selection: selectionText,
          targetLanguage: opts.targetLanguage,
          prompt: opts.prompt ?? activeDoc.aiWorkbench?.promptDraft ?? undefined,
          attachments,
        })
      } catch (error) {
        settleHistory({
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        })
        return
      }
      // `explain` is narrative by design: it does not touch the buffer, and its
      // output is rendered by the workbench's AI panel from the shared run
      // state rather than discarded here.
      if (actionType === "explain") {
        settleHistory({ status: "completed" })
        return
      }
      if (selectionText && editor && sel && !opts.proposalFirst) {
        // Selection-scoped edits stay inline (fast path).
        editor.executeEdits("canvas-action", [{ range: sel, text: result, forceMoveMarkers: true }])
        settleHistory({ status: "completed" })
      } else {
        // Whole-document rewrites open a per-hunk diff review instead of
        // silently overwriting the buffer, so the user accepts or rejects
        // before it lands.
        const model = editor?.getModel()
        const proposedContent =
          selectionText && model && sel
            ? `${model.getValue().slice(0, model.getOffsetAt(sel.getStartPosition()))}${result}${model
                .getValue()
                .slice(model.getOffsetAt(sel.getEndPosition()))}`
            : result
        const proposal = proposeCanvasReview(activeDoc.id, proposedContent, {
          actionType: actionType as CanvasWorkbenchActionType,
          requestId: historyId,
        })
        settleHistory(
          proposal
            ? { status: "pending-review", reviewId: proposal.id }
            : // No hunks means the model returned the document unchanged. That
              // is a completed action, not a proposal waiting on the user.
              { status: "completed" }
        )
      }
    },
    [
      actions,
      activeDoc,
      appendActionHistory,
      proposeCanvasReview,
      flushCommit,
      suggestions,
      updateActionHistoryEntry,
    ]
  )

  // Keep the keyboard-action ref pointing at the freshest runAction so
  // hotkey dispatches always see the current activeDoc / actions
  // closures, not the ones captured at first mount.
  useEffect(() => {
    runActionRef.current = runAction
  }, [runAction])

  const triggerSuggestions = useCallback(() => {
    if (!activeDoc) return
    const editor = editorRef.current
    const pos = editor?.getPosition() ?? null
    void suggestions.generate({
      documentId: activeDoc.id,
      language: activeDoc.language,
      content: activeDoc.content,
      cursorLine: pos?.lineNumber,
      cursorColumn: pos?.column,
    })
  }, [activeDoc, suggestions])

  useEffect(() => {
    window.addEventListener("canvas-action-suggest", triggerSuggestions)
    return () => window.removeEventListener("canvas-action-suggest", triggerSuggestions)
  }, [triggerSuggestions])

  // Auto-trigger suggestions after a typing pause when the AI settings ask for it.
  // Gated on the AI-workbench flag and idle state so it never fights an in-flight run.
  useAutoSuggestions({
    enabled:
      aiWorkbenchEnabled &&
      !isMobile &&
      Boolean(activeDoc) &&
      !actions.running &&
      !suggestions.running,
    documentId: activeId ?? "",
    content: activeDoc?.content ?? "",
    trigger: triggerSuggestions,
  })

  const onCreate = useCallback(() => {
    const id = create({
      title: t("untitledDefault"),
      content: "",
      language: "markdown",
      type: "text",
    })
    setActive(id)
  }, [create, setActive, t])

  // The degraded tier is announced, not silent. Monaco quietly dropping the
  // minimap and folding on a large file reads as breakage; saying why does not.
  const performanceNotice = performanceProfile.showDegradedModeNotice ? (
    <div
      data-testid="canvas-performance-notice"
      data-mode={performanceProfile.mode}
      role="status"
      className="flex items-center gap-2 border-b bg-muted/40 px-3 py-1.5 text-muted-foreground text-xs"
    >
      <GaugeIcon className="size-3.5 shrink-0" aria-hidden="true" />
      <span className="truncate">
        {t(
          performanceProfile.mode === "very-large"
            ? "performanceMode.veryLarge"
            : "performanceMode.large",
          { lines: performanceProfile.lineCount }
        )}
      </span>
    </div>
  ) : null

  const desktopEditorNode = activeDoc ? (
    <div className="flex h-full flex-col">
      <LspServerHint language={activeDoc.language} />
      {performanceNotice}
      <div className="min-h-0 flex-1">
        <Suspense fallback={<EditorLoading />}>
          <MonacoEditorView
            key={activeDoc.id}
            language={activeDoc.language}
            value={activeDoc.content}
            onChange={handleEditorChange}
            onMount={(editor, monaco) => {
              editorRef.current = editor
              monacoSetup.onMount(editor, monaco)
              editor.onDidChangeCursorSelection?.((event) => {
                const model = editor.getModel()
                if (!model) return
                const start = model.getOffsetAt(event.selection.getStartPosition())
                const end = model.getOffsetAt(event.selection.getEndPosition())
                window.dispatchEvent(
                  new CustomEvent("canvas-context-selection", {
                    detail: { documentId: activeDoc.id, start, end },
                  })
                )
              })
            }}
            options={monacoSetup.editorOptions as MonacoEditor.IStandaloneEditorConstructionOptions}
            theme={resolvedMonacoTheme}
          />
        </Suspense>
      </div>
      {monacoSetup.diagnostics ? (
        <MonacoDiagnosticsBar
          monaco={monacoSetup.diagnostics.monaco}
          editor={monacoSetup.diagnostics.editor}
        />
      ) : null}
    </div>
  ) : null

  const mobileEditorNode = activeDoc ? (
    // Mobile: CodeMirror light editor — Monaco's worker bundle and
    // virtual-keyboard handling are unsuited to the Capacitor shell.
    <LightCodeEditor
      key={activeDoc.id}
      value={activeDoc.content}
      language={editorLanguageFromMonacoId(activeDoc.language)}
      onChange={(v) => handleEditorChange(v)}
      aria-label={activeDoc.title}
      className="px-2"
      fontSize={editorSettings.fontSize}
      fontFamily={editorSettings.fontFamily}
      lineHeight={editorSettings.lineHeight}
      tabSize={editorSettings.tabSize}
      wordWrap={editorSettings.wordWrap}
      lineNumbers={editorSettings.lineNumbers !== "off"}
    />
  ) : null

  // Center-pane body: review > preview-only > split > editor-only. When a
  // proposal is open it takes the whole pane (the Monaco diff needs the room).
  let bodyContent: ReactNode
  if (!activeDoc) {
    bodyContent = (
      <Empty className="h-full border-0">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <FileText />
          </EmptyMedia>
          <EmptyDescription>
            {t("empty.subtitle", { default: "Select or create a document to start." })}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  } else if (reviewing) {
    bodyContent = (
      <CanvasReviewView documentId={activeDoc.id} panelMode={isMobile ? "mobile" : "desktop"} />
    )
  } else if (isMobile) {
    bodyContent =
      effectiveMode === "preview" ? (
        <CanvasPreviewPane documentId={activeDoc.id} />
      ) : (
        mobileEditorNode
      )
  } else if (effectiveMode === "preview") {
    bodyContent = <CanvasPreviewPane documentId={activeDoc.id} />
  } else if (effectiveMode === "split") {
    bodyContent = (
      <ResizablePanelGroup orientation="horizontal" className="h-full">
        <ResizablePanel id="canvas-editor-pane" defaultSize="55%" minSize="30%">
          {desktopEditorNode}
        </ResizablePanel>
        <ResizableHandle withHandle />
        <ResizablePanel id="canvas-preview-pane" defaultSize="45%" minSize="25%">
          <CanvasPreviewPane documentId={activeDoc.id} />
        </ResizablePanel>
      </ResizablePanelGroup>
    )
  } else {
    bodyContent = desktopEditorNode
  }

  return (
    <div className={cn("flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden", className)}>
      <CanvasToolbar
        documents={openDocuments}
        activeDocumentId={activeId}
        running={actions.running}
        onSelectDocument={setActive}
        onCloseDocument={handleCloseDocument}
        onCreateDocument={onCreate}
        onRenameDocument={(id, title) => updateDoc(id, { title, updatedAt: new Date() })}
        onDuplicateDocument={(id) => {
          // Read the full row from the store: the list this component holds is
          // a summary and deliberately carries no content.
          const src = useArtifactStore.getState().canvasDocuments[id]
          if (!src) return
          const dupId = create({
            title: `${src.title} ${t("copySuffix")}`,
            content: src.content,
            language: src.language,
            type: src.type,
          })
          setActive(dupId)
        }}
        onDeleteDocument={setDeleteCandidateId}
        onSaveVersion={() => activeDoc && saveVersion(activeDoc.id, "manual")}
        previewable={previewable}
        reviewing={reviewing}
        isMobile={isMobile}
      />

      <PluginExtensionSlot
        point="canvas.toolbar"
        className="flex items-center gap-1 border-b bg-muted/20 px-2 py-1 empty:hidden"
      />

      <div
        ref={editorContainerRef}
        className={cn(
          "relative min-h-0 min-w-0 flex-1 overflow-hidden",
          // Accessibility → focus indicator: draw an inset ring around the
          // editor whenever focus lands inside it, so keyboard users can see
          // where they are without hunting for the caret.
          accessibility.focusIndicator &&
            "focus-within:ring-2 focus-within:ring-inset focus-within:ring-ring/60"
        )}
      >
        {bodyContent}
        {(actions.running || suggestions.running) && (
          <div className="pointer-events-none absolute right-3 top-2 flex items-center gap-1 rounded bg-background/90 px-2 py-1 text-xs shadow">
            <Spinner className="size-3" />
            {actions.running
              ? t("running", { default: "AI working…" })
              : t("suggesting", { default: "Suggesting…" })}
          </div>
        )}
      </div>
      {actions.error && (
        <div
          className="border-t bg-destructive/5 p-2 text-xs text-destructive"
          // Accessibility → announce errors: expose the AI-action failure to
          // assistive tech as an alert region so screen readers speak it.
          role={accessibility.announceErrors ? "alert" : undefined}
          aria-live={accessibility.announceErrors ? "assertive" : "off"}
        >
          {actions.error}
        </div>
      )}

      {aiWorkbenchEnabled && (
        <CanvasInlineCommand
          running={actions.running}
          onAction={(type, options) => void runAction(type, { ...options, entryPoint: "inline" })}
          onSaveVersion={() => activeDoc && saveVersion(activeDoc.id, "manual")}
          onTriggerSuggestions={triggerSuggestions}
          onCreateDocument={onCreate}
          open={inlineCommandOpen}
          onOpenChange={(open) =>
            activeId && updateWorkbench(activeId, { isInlineCommandOpen: open })
          }
        />
      )}

      <CanvasDeleteDocumentDialog
        open={deleteCandidateId !== null}
        onOpenChange={(next) => {
          if (!next) setDeleteCandidateId(null)
        }}
        documentTitle={
          documents.find((doc) => doc.id === deleteCandidateId)?.title ?? t("untitledDefault")
        }
        versionCount={deleteCandidateId ? getCanvasVersions(deleteCandidateId).length : 0}
        onConfirm={() => {
          if (deleteCandidateId) remove(deleteCandidateId)
          setDeleteCandidateId(null)
        }}
      />
    </div>
  )
}

interface CanvasToolbarProps {
  documents: CanvasDocumentSummary[]
  activeDocumentId: string | null
  running: boolean
  onSelectDocument: (id: string) => void
  onCloseDocument: (id: string) => void
  onCreateDocument: () => void
  onRenameDocument: (id: string, title: string) => void
  onDuplicateDocument: (id: string) => void
  onDeleteDocument: (id: string) => void
  onSaveVersion: () => void
  previewable: boolean
  reviewing: boolean
  isMobile: boolean
}

function CanvasToolbar({
  documents,
  activeDocumentId,
  running,
  onSelectDocument,
  onCloseDocument,
  onCreateDocument,
  onRenameDocument,
  onDuplicateDocument,
  onDeleteDocument,
  onSaveVersion,
  previewable,
  reviewing,
  isMobile,
}: CanvasToolbarProps) {
  const t = useTranslations("canvas")
  const tActions = useTranslations("canvas.actions")
  const [renameDialogOpen, setRenameDialogOpen] = useState(false)
  const [renameDocId, setRenameDocId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState("")

  const showTabs = documents.length > 1

  const handleStartRename = (doc: CanvasDocumentSummary) => {
    setRenameDocId(doc.id)
    setRenameValue(doc.title)
    setRenameDialogOpen(true)
  }

  const handleConfirmRename = (newTitle: string) => {
    if (renameDocId) onRenameDocument(renameDocId, newTitle)
    setRenameDialogOpen(false)
    setRenameDocId(null)
    setRenameValue("")
  }

  return (
    <>
      <div className="flex items-center border-b bg-muted/30 h-9 shrink-0">
        {showTabs ? (
          <Tabs
            value={activeDocumentId ?? ""}
            onValueChange={onSelectDocument}
            className="flex-1 min-w-0"
          >
            <ScrollArea className="w-full">
              <TabsList className="bg-transparent h-9 rounded-none gap-0 p-0">
                {documents.map((doc) => (
                  <TabsTrigger
                    key={doc.id}
                    value={doc.id}
                    className="group flex items-center gap-1.5 px-3 h-9 rounded-none border-b-2 transition-colors data-[state=active]:bg-background data-[state=active]:border-primary border-transparent hover:bg-muted/50"
                    asChild
                  >
                    <div className="flex items-center gap-1.5">
                      {doc.type === "code" ? (
                        <FileCode className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                      ) : (
                        <FileText className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                      )}
                      <span className="text-xs font-medium truncate max-w-[100px]">
                        {doc.title}
                      </span>
                      <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-6 w-6 opacity-0 group-hover:opacity-100"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <MoreHorizontal className="h-3 w-3" />
                          </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="start" className="w-40">
                          <DropdownMenuItem onClick={() => handleStartRename(doc)}>
                            <Edit2 className="h-3.5 w-3.5 mr-2" />
                            {t("rename")}
                          </DropdownMenuItem>
                          <DropdownMenuItem onClick={() => onDuplicateDocument(doc.id)}>
                            <Copy className="h-3.5 w-3.5 mr-2" />
                            {t("duplicate")}
                          </DropdownMenuItem>
                          <DropdownMenuSeparator />
                          <DropdownMenuItem
                            onClick={() => onDeleteDocument(doc.id)}
                            className="text-destructive focus:text-destructive"
                          >
                            <Trash2 className="h-3.5 w-3.5 mr-2" />
                            {t("delete")}
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-6 w-6 opacity-0 group-hover:opacity-100"
                        aria-label={`${t("close")} ${doc.title}`}
                        onClick={(e) => {
                          e.stopPropagation()
                          onCloseDocument(doc.id)
                        }}
                      >
                        <X className="h-3 w-3" />
                      </Button>
                    </div>
                  </TabsTrigger>
                ))}
              </TabsList>
              <ScrollBar orientation="horizontal" className="h-1" />
            </ScrollArea>
          </Tabs>
        ) : (
          <div className="flex-1" />
        )}

        <div className="flex items-center gap-0.5 shrink-0 px-1">
          {reviewing ? (
            <span className="mr-1 hidden text-[11px] font-medium text-muted-foreground sm:inline">
              {t("reviewingChanges")}
            </span>
          ) : (
            <>{previewable && <CanvasViewModeToggle compact={isMobile} className="mr-1" />}</>
          )}

          <Tooltip delayDuration={300}>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                onClick={onCreateDocument}
                aria-label={t("newDocument")}
              >
                <Plus className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">{t("newDocument")}</TooltipContent>
          </Tooltip>

          <Tooltip delayDuration={300}>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                aria-label={t("commandPalette", { default: "Command palette" })}
                onClick={() => window.dispatchEvent(new CustomEvent("canvas-inline-command"))}
              >
                <Search className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {t("commandPalette", { default: "Command palette" })}
            </TooltipContent>
          </Tooltip>

          <Tooltip delayDuration={300}>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                onClick={onSaveVersion}
                disabled={running}
                aria-label={tActions("saveVersion", { default: "Save version" })}
              >
                <Save className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {tActions("saveVersion", { default: "Save version" })}
            </TooltipContent>
          </Tooltip>
        </div>
      </div>

      <RenameDialog
        open={renameDialogOpen}
        onOpenChange={setRenameDialogOpen}
        currentTitle={renameValue}
        onRename={handleConfirmRename}
      />
    </>
  )
}
