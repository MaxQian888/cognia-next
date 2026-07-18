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
import type { editor as MonacoEditor } from "monaco-editor"
import { useTranslations } from "next-intl"
import {
  Save,
  Wand2,
  Bug,
  Sparkles,
  HelpCircle,
  Languages,
  MoreHorizontal,
  Minimize2,
  Maximize2,
  Lightbulb,
  Search,
  Plus,
  FileCode,
  FileText,
  X,
  Copy,
  Trash2,
  Edit2,
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
import { useCanvasActions } from "@/hooks/canvas/use-canvas-actions"
import { useCanvasSuggestions } from "@/hooks/canvas/use-canvas-suggestions"
import { useAutoSuggestions } from "@/hooks/canvas/use-auto-suggestions"
import { useCanvasKeyboardShortcuts } from "@/hooks/canvas/use-canvas-keyboard-shortcuts"
import { useCanvasFeatureFlag } from "@/hooks/canvas/use-canvas-feature-flag"
import { useContextWorkbenchSurfaceFlag } from "@/hooks/context-workbench/use-context-workbench-surface-flag"
import { useCanvasSettingsStore } from "@/stores/canvas/canvas-settings-store"
import type { CanvasActionType } from "@/lib/ai/generation/canvas-actions"
import { RenameDialog } from "./rename-dialog"
import {
  DocumentFormatToolbar,
  type FormatAction,
} from "@/components/document/document-format-toolbar"
import { FORMAT_ACTION_MAP, TRANSLATE_LANGUAGES } from "@/lib/canvas/constants"
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
import type { CanvasWorkbenchActionType } from "@/types/artifact/artifact"
import { CanvasPreviewPane } from "./canvas-preview-pane"
import { CanvasReviewView } from "./canvas-review-view"
import { CanvasViewModeToggle } from "./canvas-view-mode-toggle"
import { CANVAS_GOTO_LINE_EVENT, type CanvasGotoLineDetail } from "./canvas-outline-panel"

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
  const canvasDocuments = useArtifactStore((s) => s.canvasDocuments)
  const documents = useMemo(
    () => Object.values(canvasDocuments) as CanvasDocument[],
    [canvasDocuments]
  )
  const activeId = useArtifactStore((s) => s.activeCanvasId)
  const setActive = useArtifactStore((s) => s.setActiveCanvas)
  const updateDoc = useArtifactStore((s) => s.updateCanvasDocument)
  const create = useArtifactStore((s) => s.createCanvasDocument)
  const remove = useArtifactStore((s) => s.deleteCanvasDocument)
  const saveVersion = useArtifactStore((s) => s.saveCanvasVersion)
  const proposeCanvasReview = useArtifactStore((s) => s.proposeCanvasReview)
  const previewMode = useCanvasLayoutStore((s) => s.previewMode)
  const pendingReview = useArtifactStore((s) =>
    activeId ? (s.pendingReviews[activeId] ?? null) : null
  )

  const activeDoc = useMemo(
    () => documents.find((d) => d.id === activeId) ?? null,
    [documents, activeId]
  )

  const monacoSetup = useCanvasMonacoSetup({
    documentId: activeId ?? undefined,
    language: activeDoc?.language,
    initialContent: activeDoc?.content ?? "",
  })

  const actions = useCanvasActions()
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
  const contextWorkbenchEnabled = useContextWorkbenchSurfaceFlag("canvas")
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

  // Ctrl+S / Ctrl+Shift+S arrive as `canvas-save` from the keybinding handler
  // (the panel owns the editor buffer, so the save lives here). "manual" flushes
  // the live buffer into the store; "version" additionally snapshots a version.
  useEffect(() => {
    const handler = (ev: Event) => {
      if (!activeId) return
      const mode = (ev as CustomEvent<{ mode?: string }>).detail?.mode
      const content = editorRef.current?.getValue()
      if (typeof content === "string") updateDoc(activeId, { content, updatedAt: new Date() })
      if (mode === "version") saveVersion(activeId, "manual")
    }
    window.addEventListener("canvas-save", handler as EventListener)
    return () => window.removeEventListener("canvas-save", handler as EventListener)
  }, [activeId, updateDoc, saveVersion])

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
  }, [activeId, autoSaveSeconds, saveVersion, updateDoc])

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

  const handleEditorChange = useCallback(
    (value: string | undefined) => {
      if (!activeId) return
      updateDoc(activeId, { content: value ?? "", updatedAt: new Date() })
    },
    [activeId, updateDoc]
  )

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
      opts: { targetLanguage?: string; prompt?: string; proposalFirst?: boolean } = {}
    ) => {
      if (!activeDoc) return
      const editor = editorRef.current
      const sel = editor?.getSelection()
      const selectionText =
        editor && sel && !sel.isEmpty()
          ? (editor.getModel()?.getValueInRange(sel) ?? undefined)
          : undefined
      const result = await actions.run({
        actionType,
        content: activeDoc.content,
        language: activeDoc.language,
        selection: selectionText,
        targetLanguage: opts.targetLanguage,
        prompt: opts.prompt,
      })
      if (actionType === "review" || actionType === "explain") return // narrative actions, don't replace
      if (selectionText && editor && sel && !opts.proposalFirst) {
        // Selection-scoped edits stay inline (fast path).
        editor.executeEdits("canvas-action", [{ range: sel, text: result, forceMoveMarkers: true }])
      } else {
        // Whole-document rewrites open a per-hunk diff review instead of
        // silently overwriting the buffer — accept/reject before it lands.
        const model = editor?.getModel()
        const proposedContent =
          selectionText && model && sel
            ? `${model.getValue().slice(0, model.getOffsetAt(sel.getStartPosition()))}${result}${model
                .getValue()
                .slice(model.getOffsetAt(sel.getEndPosition()))}`
            : result
        proposeCanvasReview(activeDoc.id, proposedContent, {
          actionType: actionType as CanvasWorkbenchActionType,
        })
      }
    },
    [actions, activeDoc, proposeCanvasReview]
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

  const desktopEditorNode = activeDoc ? (
    <div className="flex h-full flex-col">
      <LspServerHint language={activeDoc.language} />
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
        documents={documents}
        activeDocumentId={activeId}
        isText={activeDoc?.type === "text"}
        running={actions.running}
        onSelectDocument={setActive}
        onCloseDocument={(id) => {
          // Closing a tab removes the document from the workspace (canvas has no
          // separate "open vs all" state) and moves focus to a sibling.
          if (activeId === id) {
            const next = documents.find((d) => d.id !== id)
            setActive(next?.id ?? null)
          }
          remove(id)
        }}
        onCreateDocument={onCreate}
        onRenameDocument={(id, title) => updateDoc(id, { title, updatedAt: new Date() })}
        onDuplicateDocument={(id) => {
          const src = documents.find((d) => d.id === id)
          if (!src) return
          const dupId = create({
            title: `${src.title} ${t("copySuffix")}`,
            content: src.content,
            language: src.language,
            type: src.type,
          })
          setActive(dupId)
        }}
        onDeleteDocument={(id) => {
          remove(id)
          if (activeId === id) setActive(null)
        }}
        onAction={runAction}
        onTriggerSuggestions={triggerSuggestions}
        onSaveVersion={() => activeDoc && saveVersion(activeDoc.id, "manual")}
        onFormat={handleFormat}
        aiEnabled={aiWorkbenchEnabled}
        previewable={previewable}
        reviewing={reviewing}
        isMobile={isMobile}
        contextWorkbenchEnabled={contextWorkbenchEnabled}
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
          onAction={runAction}
          onSaveVersion={() => activeDoc && saveVersion(activeDoc.id, "manual")}
          onTriggerSuggestions={triggerSuggestions}
          onCreateDocument={onCreate}
        />
      )}
    </div>
  )
}

interface CanvasToolbarProps {
  documents: CanvasDocument[]
  activeDocumentId: string | null
  isText: boolean
  running: boolean
  onSelectDocument: (id: string) => void
  onCloseDocument: (id: string) => void
  onCreateDocument: () => void
  onRenameDocument: (id: string, title: string) => void
  onDuplicateDocument: (id: string) => void
  onDeleteDocument: (id: string) => void
  onAction: (
    actionType: CanvasActionType,
    opts?: { targetLanguage?: string; prompt?: string }
  ) => Promise<void>
  onTriggerSuggestions: () => void
  onSaveVersion: () => void
  onFormat: (action: FormatAction) => void
  aiEnabled: boolean
  previewable: boolean
  reviewing: boolean
  isMobile: boolean
  contextWorkbenchEnabled: boolean
}

function CanvasToolbar({
  documents,
  activeDocumentId,
  isText,
  running,
  onSelectDocument,
  onCloseDocument,
  onCreateDocument,
  onRenameDocument,
  onDuplicateDocument,
  onDeleteDocument,
  onAction,
  onTriggerSuggestions,
  onSaveVersion,
  onFormat,
  aiEnabled,
  previewable,
  reviewing,
  isMobile,
  contextWorkbenchEnabled,
}: CanvasToolbarProps) {
  const t = useTranslations("canvas")
  const tActions = useTranslations("canvas.actions")
  const [renameDialogOpen, setRenameDialogOpen] = useState(false)
  const [renameDocId, setRenameDocId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState("")

  const showTabs = documents.length > 1

  const handleStartRename = (doc: CanvasDocument) => {
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

          {contextWorkbenchEnabled ? (
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
          ) : (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  disabled={running}
                  aria-label={tActions("more", { default: "More actions" })}
                >
                  <MoreHorizontal className="size-3.5" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-48">
                {aiEnabled && (
                  <>
                    <DropdownMenuItem onClick={() => void onAction("review")} disabled={running}>
                      <Wand2 className="mr-2 size-3.5" />
                      {tActions("review")}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => void onAction("fix")} disabled={running}>
                      <Bug className="mr-2 size-3.5" />
                      {tActions("fix")}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => void onAction("improve")} disabled={running}>
                      <Sparkles className="mr-2 size-3.5" />
                      {tActions("improve")}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <DropdownMenuItem disabled={running} onSelect={(e) => e.preventDefault()}>
                          <Languages className="mr-2 size-3.5" />
                          {tActions("translate")}
                        </DropdownMenuItem>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="start" side="left">
                        {TRANSLATE_LANGUAGES.map((l) => (
                          <DropdownMenuItem
                            key={l.value}
                            onClick={() => void onAction("translate", { targetLanguage: l.value })}
                          >
                            {l.label}
                          </DropdownMenuItem>
                        ))}
                      </DropdownMenuContent>
                    </DropdownMenu>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => void onAction("explain")} disabled={running}>
                      <HelpCircle className="mr-2 size-3.5" />
                      {tActions("explain")}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => void onAction("simplify")} disabled={running}>
                      <Minimize2 className="mr-2 size-3.5" />
                      {tActions("simplify")}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => void onAction("expand")} disabled={running}>
                      <Maximize2 className="mr-2 size-3.5" />
                      {tActions("expand")}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={onTriggerSuggestions} disabled={running}>
                      <Lightbulb className="mr-2 size-3.5" />
                      {tActions("suggest", { default: "Suggest" })}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                  </>
                )}
                <DropdownMenuItem onClick={onSaveVersion} disabled={running}>
                  <Save className="mr-2 size-3.5" />
                  {tActions("saveVersion", { default: "Save version" })}
                </DropdownMenuItem>
                {isText && (
                  <>
                    <DropdownMenuSeparator />
                    <div className="px-2 py-1.5">
                      <DocumentFormatToolbar
                        onAction={onFormat}
                        className="border-0 bg-transparent p-0 justify-start"
                      />
                    </div>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
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
