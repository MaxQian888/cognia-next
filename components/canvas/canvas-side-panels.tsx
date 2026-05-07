"use client"

/**
 * Canvas Side Panels — replaces MemberList in the Canvas guild. Hosts
 * the Suggestions / History / Comments / Collaboration / Execution
 * tabs to the right of the editor. Tabs show badge counts, content
 * panels render inline where feasible, and empty states use consistent
 * centered icon + description + CTA patterns.
 */

import { useEffect, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { Lightbulb, History as HistoryIcon, MessageSquare, Users, Play } from "lucide-react"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { useCommentStore } from "@/stores/canvas/comment-store"
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

  const documents = useArtifactStore((s) => s.canvasDocuments)
  const getCanvasVersions = useArtifactStore((s) => s.getCanvasVersions)
  const getComments = useCommentStore((s) => s.getComments)

  const tabBadges = useMemo(() => {
    const doc = documents[activeId ?? ""]
    const suggestions = doc?.aiSuggestions ?? []
    const versions = getCanvasVersions(activeId ?? "")
    const comments = getComments(activeId ?? "")
    return {
      suggestions: suggestions.filter((s) => s.status === "pending").length,
      history: versions.length,
      comments: comments.filter((c) => c.status !== "resolved").length,
      collaboration: 0,
      execution: 0,
    }
  }, [activeId, documents, getCanvasVersions, getComments])

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
    <div ref={containerRef} className="flex h-full min-h-0 min-w-0 flex-col">
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
            badge={tabBadges.suggestions}
          />
          <PanelTab
            value="history"
            icon={<HistoryIcon className="size-3.5" />}
            label={t("history", { default: "History" })}
            iconOnly={iconOnly}
            badge={tabBadges.history}
          />
          <PanelTab
            value="comments"
            icon={<MessageSquare className="size-3.5" />}
            label={t("comments", { default: "Comments" })}
            iconOnly={iconOnly}
            badge={tabBadges.comments}
          />
          <PanelTab
            value="collaboration"
            icon={<Users className="size-3.5" />}
            label={t("collaboration", { default: "Collab" })}
            iconOnly={iconOnly}
            badge={tabBadges.collaboration}
          />
          <PanelTab
            value="execution"
            icon={<Play className="size-3.5" />}
            label={t("execution", { default: "Run" })}
            iconOnly={iconOnly}
            badge={tabBadges.execution}
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
  badge?: number
}

function PanelTab({ value, icon, label, iconOnly, badge }: PanelTabProps) {
  const showBadge = badge !== undefined && badge > 0
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
        {showBadge && (
          <span className="ml-0.5 inline-flex items-center justify-center rounded-full bg-primary px-1 py-0 text-[9px] font-medium text-primary-foreground leading-none min-w-[14px] h-3.5">
            {badge > 99 ? "99+" : badge}
          </span>
        )}
      </span>
    </TabsTrigger>
  )
  if (!iconOnly) return trigger
  return (
    <Tooltip delayDuration={300}>
      <TooltipTrigger asChild>{trigger}</TooltipTrigger>
      <TooltipContent side="bottom">
        {label}
        {showBadge && ` (${badge})`}
      </TooltipContent>
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

  if (suggestions.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2 p-6 text-center">
        <Lightbulb className="size-6 text-muted-foreground/30" />
        <p className="text-xs text-muted-foreground">
          {t("suggestionsEmpty", {
            default: "No suggestions yet. Use the Suggest action to generate improvements.",
          })}
        </p>
      </div>
    )
  }
  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <SuggestionsPanel documentId={documentId} suggestions={suggestions} />
    </div>
  )
}

/**
 * Renders the Cognia VersionHistoryPanel as a Sheet trigger button.
 * The panel itself opens its own Sheet with full diff support.
 */
function HistoryHost({ documentId }: { documentId: string }) {
  const t = useTranslations("canvas.panels")
  const getCanvasVersions = useArtifactStore((s) => s.getCanvasVersions)
  const versions = getCanvasVersions(documentId)

  if (versions.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2 p-6 text-center">
        <HistoryIcon className="size-6 text-muted-foreground/30" />
        <p className="text-xs text-muted-foreground">
          {t("historyEmpty", {
            default: "No versions yet. Auto-save creates snapshots as you edit.",
          })}
        </p>
      </div>
    )
  }

  const recent = versions.slice(0, 3)

  return (
    <div className="flex h-full flex-col">
      <div className="flex-1 min-h-0 overflow-y-auto p-3 space-y-1">
        {recent.map((v) => (
          <div key={v.id} className="flex items-center gap-2 text-xs text-muted-foreground py-1">
            <span className="truncate flex-1">
              {v.description || new Date(v.createdAt).toLocaleString()}
            </span>
            {v.isAutoSave && (
              <Badge variant="outline" className="text-[9px] px-1 h-4 shrink-0">
                auto
              </Badge>
            )}
          </div>
        ))}
        {versions.length > 3 && (
          <p className="text-[10px] text-muted-foreground/60 pt-1">
            {t("moreVersions", { default: "+{count} more" }).replace(
              "{count}",
              String(versions.length - 3)
            )}
          </p>
        )}
      </div>
      <div className="p-3 pt-0">
        <VersionHistoryPanel
          documentId={documentId}
          trigger={
            <Button size="sm" variant="outline" className="w-full text-xs">
              <HistoryIcon className="mr-2 size-3.5" />
              {t("openHistory", { default: "Open full history" })}
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
  const getComments = useCommentStore((s) => s.getComments)
  const comments = getComments(documentId)
  const unresolved = comments.filter((c) => c.status !== "resolved")

  if (comments.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-2 p-6 text-center">
        <MessageSquare className="size-6 text-muted-foreground/30" />
        <p className="text-xs text-muted-foreground">
          {t("commentsEmpty", {
            default: "No comments yet. Add line-anchored comments to collaborate.",
          })}
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-2 p-3">
      <p className="text-xs text-muted-foreground">
        {t("commentsSummary", { default: "{count} comments ({unresolved} unresolved)" })
          .replace("{count}", String(comments.length))
          .replace("{unresolved}", String(unresolved.length))}
      </p>
      <CommentPanel
        documentId={documentId}
        trigger={
          <Button size="sm" variant="outline" className="w-full text-xs">
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
    <div className="flex flex-col items-center justify-center h-full gap-2 p-6 text-center">
      <Users className="size-6 text-muted-foreground/30" />
      <p className="text-xs text-muted-foreground">
        {t("collabHint", {
          default:
            "Real-time collaboration is disabled by default. Enable it in Settings → Canvas → Collaboration.",
        })}
      </p>
      <CollaborationPanel
        documentId={documentId}
        documentContent={doc?.content ?? ""}
        trigger={
          <Button size="sm" variant="outline" className="text-xs">
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
