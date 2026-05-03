"use client"

/**
 * Canvas Side Panels — replaces MemberList in the Canvas guild. Hosts
 * the Suggestions / History / Comments / Collaboration / Execution
 * tabs to the right of the editor. Wires the real Cognia panel
 * implementations so the dock has parity with Cognia's canvas surface.
 */

import { useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { Lightbulb, History as HistoryIcon, MessageSquare, Users, Play } from "lucide-react"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { useCanvasLayoutStore, type CanvasRightTab } from "@/stores/canvas/canvas-layout-store"
import { SuggestionsPanel } from "./suggestions-panel"
import { VersionHistoryPanel } from "./version-history-panel"
import { CommentPanel } from "./comment-panel"
import { CollaborationPanel } from "./collaboration-panel"
import { CodeExecutionPanel } from "./code-execution-panel"
import { useCanvasCodeExecution } from "@/hooks/canvas"

export const CANVAS_SIDE_PANELS_ICON_ONLY_BREAKPOINT = 280

export function CanvasSidePanels() {
  const t = useTranslations("canvas.panels")
  const activeId = useArtifactStore((s) => s.activeCanvasId)
  const activeRightTab = useCanvasLayoutStore((s) => s.activeRightTab)
  const setActiveRightTab = useCanvasLayoutStore((s) => s.setActiveRightTab)

  const containerRef = useRef<HTMLDivElement | null>(null)
  const [iconOnly, setIconOnly] = useState(false)

  useEffect(() => {
    const el = containerRef.current
    if (!el || typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      setIconOnly(entry.contentRect.width < CANVAS_SIDE_PANELS_ICON_ONLY_BREAKPOINT)
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  if (!activeId) {
    return (
      <div
        ref={containerRef}
        className="flex h-full items-center justify-center p-4 text-center text-xs text-muted-foreground"
      >
        {t("emptyHint", { default: "Open a document to see suggestions, history and comments." })}
      </div>
    )
  }

  return (
    <div ref={containerRef} className="flex h-full min-h-0 flex-col">
      <Tabs
        value={activeRightTab}
        onValueChange={(value) => setActiveRightTab(value as CanvasRightTab)}
        className="flex h-full min-h-0 flex-col"
      >
        <TabsList className="flex h-auto w-full justify-start gap-0 rounded-none border-b bg-muted/30 p-0">
          <PanelTab
            value="suggestions"
            icon={<Lightbulb className="size-3.5" />}
            label={t("suggestions", { default: "Suggestions" })}
            iconOnly={iconOnly}
          />
          <PanelTab
            value="history"
            icon={<HistoryIcon className="size-3.5" />}
            label={t("history", { default: "History" })}
            iconOnly={iconOnly}
          />
          <PanelTab
            value="comments"
            icon={<MessageSquare className="size-3.5" />}
            label={t("comments", { default: "Comments" })}
            iconOnly={iconOnly}
          />
          <PanelTab
            value="collaboration"
            icon={<Users className="size-3.5" />}
            label={t("collaboration", { default: "Collab" })}
            iconOnly={iconOnly}
          />
          <PanelTab
            value="execution"
            icon={<Play className="size-3.5" />}
            label={t("execution", { default: "Run" })}
            iconOnly={iconOnly}
          />
        </TabsList>

        <TabsContent value="suggestions" className="m-0 flex-1 min-h-0 overflow-hidden">
          <SuggestionsHost documentId={activeId} />
        </TabsContent>
        <TabsContent value="history" className="m-0 flex-1 min-h-0 overflow-hidden">
          <HistoryHost documentId={activeId} />
        </TabsContent>
        <TabsContent value="comments" className="m-0 flex-1 min-h-0 overflow-hidden">
          <CommentsHost documentId={activeId} />
        </TabsContent>
        <TabsContent value="collaboration" className="m-0 flex-1 min-h-0 overflow-hidden">
          <CollaborationHost documentId={activeId} />
        </TabsContent>
        <TabsContent value="execution" className="m-0 flex-1 min-h-0 overflow-hidden">
          <ExecutionHost documentId={activeId} />
        </TabsContent>
      </Tabs>
    </div>
  )
}

interface PanelTabProps {
  value: string
  icon: React.ReactNode
  label: string
  iconOnly: boolean
}

function PanelTab({ value, icon, label, iconOnly }: PanelTabProps) {
  const trigger = (
    <TabsTrigger
      value={value}
      aria-label={label}
      className={cn(
        "h-9 flex-1 rounded-none border-b-2 border-transparent text-xs data-[state=active]:border-primary data-[state=active]:bg-background",
        iconOnly ? "px-1" : "px-2"
      )}
    >
      <span className="flex items-center justify-center gap-1.5">
        {icon}
        {!iconOnly && <span className="truncate">{label}</span>}
      </span>
    </TabsTrigger>
  )
  if (!iconOnly) return trigger
  return (
    <Tooltip delayDuration={300}>
      <TooltipTrigger asChild>{trigger}</TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  )
}

/**
 * Wraps the Cognia SuggestionsPanel with the active document's
 * suggestions list pulled from the artifact store.
 */
function SuggestionsHost({ documentId }: { documentId: string }) {
  const t = useTranslations("canvas.panels")
  const documents = useArtifactStore((s) => s.canvasDocuments)
  const doc = documents[documentId]
  const suggestions = doc?.aiSuggestions ?? []
  const pending = suggestions.filter((s) => s.status === "pending")
  if (pending.length === 0) {
    return (
      <p className="p-3 text-center text-xs text-muted-foreground">
        {t("suggestionsEmpty", {
          default: "No suggestions yet. Use the Suggest button on the toolbar.",
        })}
      </p>
    )
  }
  return <SuggestionsPanel documentId={documentId} suggestions={suggestions} />
}

/**
 * Renders the Cognia VersionHistoryPanel as a Sheet trigger button.
 * The panel itself opens its own Sheet with full diff support.
 */
function HistoryHost({ documentId }: { documentId: string }) {
  const t = useTranslations("canvas.panels")
  const getCanvasVersions = useArtifactStore((s) => s.getCanvasVersions)
  const versions = getCanvasVersions(documentId)
  return (
    <div className="flex h-full flex-col">
      <div className="space-y-2 p-3">
        <p className="text-xs text-muted-foreground">
          {t("historyHint", {
            default:
              "Snapshots are captured on every auto-save. Open the full panel for diff and restore.",
          })}
        </p>
        <VersionHistoryPanel
          documentId={documentId}
          trigger={
            <Button size="sm" className="w-full text-xs">
              <HistoryIcon className="mr-2 size-3.5" />
              {t("openHistory", { default: "Open history" })}{" "}
              <span className="ml-1 opacity-60">({versions.length})</span>
            </Button>
          }
        />
      </div>
    </div>
  )
}

/**
 * Renders the Cognia CommentPanel inside a Sheet trigger button.
 */
function CommentsHost({ documentId }: { documentId: string }) {
  const t = useTranslations("canvas.panels")
  return (
    <div className="space-y-2 p-3">
      <p className="text-xs text-muted-foreground">
        {t("commentsHint", {
          default: "Comments are line-anchored. Open the full panel to thread, react, and resolve.",
        })}
      </p>
      <CommentPanel
        documentId={documentId}
        trigger={
          <Button size="sm" className="w-full text-xs">
            <MessageSquare className="mr-2 size-3.5" />
            {t("openComments", { default: "Open comments" })}
          </Button>
        }
      />
    </div>
  )
}

/**
 * Mounts the Cognia CollaborationPanel content inline so the user
 * can see participants + connection state directly in the right rail.
 */
function CollaborationHost({ documentId }: { documentId: string }) {
  const t = useTranslations("canvas.panels")
  const documents = useArtifactStore((s) => s.canvasDocuments)
  const doc = documents[documentId]
  return (
    <div className="space-y-2 p-3">
      <p className="text-xs text-muted-foreground">
        {t("collabHint", {
          default:
            "Real-time collaboration is disabled by default. Enable it in Settings → Canvas → Collaboration and provide a CRDT signalling URL.",
        })}
      </p>
      <CollaborationPanel
        documentId={documentId}
        documentContent={doc?.content ?? ""}
        trigger={
          <Button size="sm" className="w-full text-xs">
            <Users className="mr-2 size-3.5" />
            {t("openCollab", { default: "Open collaboration" })}
          </Button>
        }
      />
    </div>
  )
}

/**
 * Mounts the Cognia CodeExecutionPanel inline. The hook performs the
 * sandboxed run via `lib/native/code-execution-strategy.ts` which
 * routes JS to an iframe and Python through the Tauri sidecar.
 */
function ExecutionHost({ documentId }: { documentId: string }) {
  const documents = useArtifactStore((s) => s.canvasDocuments)
  const doc = documents[documentId]
  const language = doc?.language ?? "javascript"
  const { execute, cancel, clear, result, isExecuting } = useCanvasCodeExecution()
  return (
    <CodeExecutionPanel
      result={result}
      isExecuting={isExecuting}
      language={language}
      onExecute={() => void execute(doc?.content ?? "", language)}
      onCancel={() => cancel()}
      onClear={() => clear()}
      className="border-t-0"
    />
  )
}
