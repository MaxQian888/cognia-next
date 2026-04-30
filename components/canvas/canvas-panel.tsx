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

import { Suspense, useCallback, useEffect, useMemo, useRef } from "react"
import dynamic from "next/dynamic"
import type { editor as MonacoEditor } from "monaco-editor"
import { useTheme } from "next-themes"
import { useTranslations } from "next-intl"
import { Loader2, Save, Wand2, Bug, Sparkles, HelpCircle, Languages } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Separator } from "@/components/ui/separator"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import type { CanvasDocument } from "@/types/artifact/artifact"
import { useCanvasMonacoSetup } from "@/hooks/canvas/use-canvas-monaco-setup"
import { useCanvasActions } from "@/hooks/canvas/use-canvas-actions"
import { useCanvasSuggestions } from "@/hooks/canvas/use-canvas-suggestions"
import { useCanvasKeyboardShortcuts } from "@/hooks/canvas/use-canvas-keyboard-shortcuts"
import { useCanvasSettingsStore } from "@/stores/canvas/canvas-settings-store"
import { CanvasDocumentTabs } from "./canvas-document-tabs"
import {
  DocumentFormatToolbar,
  type FormatAction,
} from "@/components/document/document-format-toolbar"
import { FORMAT_ACTION_MAP, TRANSLATE_LANGUAGES } from "@/lib/canvas/constants"
import type { CanvasActionType } from "@/lib/ai/generation/canvas-actions"

const MonacoEditorView = dynamic(() => import("@monaco-editor/react").then((mod) => mod.default), {
  ssr: false,
  loading: () => <EditorLoading />,
})

interface CanvasPanelProps {
  className?: string
  /** Optional: the side panel content rendered to the right of the editor. */
  sidePanel?: React.ReactNode
}

function EditorLoading() {
  const t = useTranslations("canvas")
  return (
    <div className="flex h-full items-center justify-center bg-muted/20 text-sm text-muted-foreground">
      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
      {t("loadingEditor")}
    </div>
  )
}

export function CanvasPanel({ className, sidePanel }: CanvasPanelProps) {
  const t = useTranslations("canvas")
  const documents = useArtifactStore((s) => Object.values(s.canvasDocuments) as CanvasDocument[])
  const activeId = useArtifactStore((s) => s.activeCanvasId)
  const setActive = useArtifactStore((s) => s.setActiveCanvas)
  const updateDoc = useArtifactStore((s) => s.updateCanvasDocument)
  const create = useArtifactStore((s) => s.createCanvasDocument)
  const remove = useArtifactStore((s) => s.deleteCanvasDocument)
  const saveVersion = useArtifactStore((s) => s.saveCanvasVersion)

  const activeDoc = useMemo(
    () => documents.find((d) => d.id === activeId) ?? null,
    [documents, activeId]
  )

  const monacoSetup = useCanvasMonacoSetup({
    documentId: activeId ?? undefined,
    language: activeDoc?.language,
  })

  const actions = useCanvasActions()
  const suggestions = useCanvasSuggestions()
  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null)
  const { resolvedTheme } = useTheme()
  // Monaco accepts only specific theme ids ("vs", "vs-dark", etc).
  // Resolve "auto" to vs / vs-dark via the next-themes resolved theme
  // so we never pass an unknown id at first render. The hook's effect
  // re-applies on changes; this prevents an initial flash.
  const resolvedMonacoTheme = useMemo(() => {
    const theme = monacoSetup.settings.theme
    if (theme && theme !== "auto") return theme
    return resolvedTheme === "dark" ? "vs-dark" : "vs"
  }, [monacoSetup.settings.theme, resolvedTheme])

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
  const runActionRef = useRef<((t: CanvasActionType) => Promise<void>) | null>(null)
  useEffect(() => {
    const handler = (ev: Event) => {
      const detail = (ev as CustomEvent<{ type?: string }>).detail
      if (!detail || !detail.type) return
      void runActionRef.current?.(detail.type as CanvasActionType)
    }
    window.addEventListener("canvas-action", handler as EventListener)
    return () => window.removeEventListener("canvas-action", handler as EventListener)
  }, [])

  // Lightweight auto-save: every `autoSaveInterval` seconds, push the
  // editor's current value into the artifact store and write a snapshot
  // marked as auto-save. The artifact-store handles version retention;
  // the dexie-bridge mirrors the snapshot to IndexedDB for backup.
  const autoSaveSeconds = useCanvasSettingsStore((s) => s.settings.version.autoSaveInterval)
  useEffect(() => {
    if (!activeId) return
    const timer = setInterval(
      () => {
        const content = editorRef.current?.getValue()
        if (typeof content !== "string") return
        updateDoc(activeId, { content, updatedAt: new Date() })
        saveVersion(activeId, "auto-save")
      },
      Math.max(10, autoSaveSeconds) * 1000
    )
    return () => clearInterval(timer)
  }, [activeId, autoSaveSeconds, saveVersion, updateDoc])

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
      if (!editor) return
      const sel = editor.getSelection()
      const selectionText =
        sel && !sel.isEmpty() ? (editor.getModel()?.getValueInRange(sel) ?? "") : ""
      insertAtSelection(`${mapping.prefix}${selectionText}${mapping.suffix}`)
    },
    [insertAtSelection]
  )

  const runAction = useCallback(
    async (
      actionType: CanvasActionType,
      opts: { targetLanguage?: string; prompt?: string } = {}
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
      if (selectionText && editor && sel) {
        editor.executeEdits("canvas-action", [{ range: sel, text: result, forceMoveMarkers: true }])
      } else {
        updateDoc(activeDoc.id, { content: result, updatedAt: new Date() })
      }
    },
    [actions, activeDoc, updateDoc]
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

  const onCreate = useCallback(() => {
    const id = create({
      title: t("untitledDefault"),
      content: "",
      language: "markdown",
      type: "text",
    })
    setActive(id)
  }, [create, setActive, t])

  return (
    <div className={cn("flex h-full min-h-0 flex-1 overflow-hidden", className)}>
      <div className="flex min-w-0 flex-1 flex-col">
        <CanvasDocumentTabs
          documents={documents}
          activeDocumentId={activeId}
          onSelectDocument={setActive}
          onCloseDocument={(id) => {
            if (activeId === id) {
              const next = documents.find((d) => d.id !== id)
              setActive(next?.id ?? null)
            }
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
        />

        <ActionToolbar
          activeDocLanguage={activeDoc?.language ?? "markdown"}
          isText={activeDoc?.type === "text"}
          onAction={runAction}
          onTriggerSuggestions={triggerSuggestions}
          running={actions.running}
          onSaveVersion={() => activeDoc && saveVersion(activeDoc.id, "manual")}
          onFormat={handleFormat}
        />

        <div className="relative min-h-0 flex-1">
          {activeDoc ? (
            <Suspense fallback={<EditorLoading />}>
              <MonacoEditorView
                key={activeDoc.id}
                language={activeDoc.language}
                value={activeDoc.content}
                onChange={handleEditorChange}
                onMount={(editor, monaco) => {
                  editorRef.current = editor
                  monacoSetup.onMount(editor, monaco)
                }}
                options={
                  monacoSetup.editorOptions as MonacoEditor.IStandaloneEditorConstructionOptions
                }
                theme={resolvedMonacoTheme}
              />
            </Suspense>
          ) : (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              {t("empty.subtitle", { default: "Select or create a document to start." })}
            </div>
          )}
          {(actions.running || suggestions.running) && (
            <div className="pointer-events-none absolute right-3 top-2 flex items-center gap-1 rounded bg-background/90 px-2 py-1 text-xs shadow">
              <Loader2 className="h-3 w-3 animate-spin" />
              {actions.running
                ? t("running", { default: "AI working…" })
                : t("suggesting", { default: "Suggesting…" })}
            </div>
          )}
        </div>
        {actions.error && (
          <div className="border-t bg-destructive/5 p-2 text-xs text-destructive">
            {actions.error}
          </div>
        )}
      </div>

      {sidePanel && (
        <>
          <Separator orientation="vertical" />
          <aside className="w-[300px] shrink-0 overflow-hidden">
            <ScrollArea className="h-full">{sidePanel}</ScrollArea>
          </aside>
        </>
      )}
    </div>
  )
}

interface ActionToolbarProps {
  activeDocLanguage: string
  isText: boolean
  running: boolean
  onAction: (
    actionType: CanvasActionType,
    opts?: { targetLanguage?: string; prompt?: string }
  ) => Promise<void>
  onTriggerSuggestions: () => void
  onSaveVersion: () => void
  onFormat: (action: FormatAction) => void
}

function ActionToolbar({
  isText,
  running,
  onAction,
  onTriggerSuggestions,
  onSaveVersion,
  onFormat,
}: ActionToolbarProps) {
  const t = useTranslations("canvas.actions")
  return (
    <div className="flex flex-wrap items-center gap-1 border-b bg-muted/20 px-2 py-1.5">
      <ActionButton
        icon={<Wand2 className="size-3.5" />}
        label={t("review")}
        onClick={() => void onAction("review")}
        disabled={running}
      />
      <ActionButton
        icon={<Bug className="size-3.5" />}
        label={t("fix")}
        onClick={() => void onAction("fix")}
        disabled={running}
      />
      <ActionButton
        icon={<Sparkles className="size-3.5" />}
        label={t("improve")}
        onClick={() => void onAction("improve")}
        disabled={running}
      />
      <ActionButton
        icon={<HelpCircle className="size-3.5" />}
        label={t("explain")}
        onClick={() => void onAction("explain")}
        disabled={running}
      />
      <ActionButton
        icon={<Sparkles className="size-3.5" />}
        label={t("simplify")}
        onClick={() => void onAction("simplify")}
        disabled={running}
      />
      <ActionButton
        icon={<Sparkles className="size-3.5" />}
        label={t("expand")}
        onClick={() => void onAction("expand")}
        disabled={running}
      />

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" className="h-7 gap-1 px-2 text-xs" disabled={running}>
            <Languages className="size-3.5" /> {t("translate")}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
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

      <Separator orientation="vertical" className="mx-1 h-5" />

      <ActionButton
        icon={<Sparkles className="size-3.5" />}
        label={t("suggest", { default: "Suggest" })}
        onClick={onTriggerSuggestions}
        disabled={running}
      />

      <ActionButton
        icon={<Save className="size-3.5" />}
        label={t("saveVersion", { default: "Save version" })}
        onClick={onSaveVersion}
        disabled={running}
      />

      {isText && (
        <>
          <Separator orientation="vertical" className="mx-1 h-5" />
          <DocumentFormatToolbar onAction={onFormat} className="border-0 bg-transparent p-0" />
        </>
      )}
    </div>
  )
}

interface ActionButtonProps {
  icon: React.ReactNode
  label: string
  onClick: () => void
  disabled?: boolean
}

function ActionButton({ icon, label, onClick, disabled }: ActionButtonProps) {
  return (
    <Tooltip delayDuration={300}>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 gap-1 px-2 text-xs"
          onClick={onClick}
          disabled={disabled}
        >
          {icon} <span>{label}</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  )
}
