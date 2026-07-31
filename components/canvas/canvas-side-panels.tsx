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
import { AnimatePresence, motion } from "motion/react"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
} from "@/components/ui/empty"
import { cn } from "@/lib/utils"
import {
  Bug,
  Expand,
  HelpCircle,
  Lightbulb,
  History as HistoryIcon,
  Languages,
  MessageSquare,
  Minimize2,
  Sparkles,
  Wand2,
  Users,
  Play,
  ListTree,
  Eye,
  InfoIcon,
} from "lucide-react"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { useCommentStore } from "@/stores/canvas/comment-store"
import { useCanvasLayoutStore, type CanvasRightTab } from "@/stores/canvas/canvas-layout-store"
import { mobileTransition, STAGGER_CHILD, STAGGER_CONTAINER } from "@/lib/ui/motion"
import { SuggestionsPanel } from "./suggestions-panel"
import { VersionHistoryPanel } from "./version-history-panel"
import { CommentPanel } from "./comment-panel"
import { CollaborationPanel } from "./collaboration-panel"
import { CodeExecutionPanel } from "./code-execution-panel"
import { CanvasOutlinePanel, countCanvasSymbols, parseCanvasSymbols } from "./canvas-outline-panel"
import { useCanvasCodeExecution } from "@/hooks/canvas"
import { useContextWorkbenchSurfaceFlag } from "@/hooks/context-workbench/use-context-workbench-surface-flag"
import { useCanvasFeatureFlag } from "@/hooks/canvas/use-canvas-feature-flag"
import { PluginExtensionSlot } from "@/components/plugins/plugin-extension-slot"
import { ContextWorkbench } from "@/components/context-workbench/context-workbench"
import { useContextWorkbenchStore } from "@/stores/context-workbench/context-workbench-store"
import type { ContextPanelDefinition, ContextResource } from "@/types/context-workbench"
import { ResourceWorkbenchChatPanel } from "@/components/context-workbench/resource-workbench-chat-panel"
import { CanvasReviewView } from "./canvas-review-view"
import { CanvasPreviewPane } from "./canvas-preview-pane"
import { ContextMetadataPanel } from "@/components/context-workbench/context-metadata-panel"
import { ContextCommentsPanel } from "@/components/context-workbench/context-comments-panel"
import { CanvasExportMenu } from "./canvas-export-menu"
import { CanvasLanguageSelect } from "./canvas-language-select"
import {
  DocumentFormatToolbar,
  type FormatAction,
} from "@/components/document/document-format-toolbar"
import { TRANSLATE_LANGUAGES } from "@/lib/canvas/constants"
import type { CanvasActionType } from "@/lib/ai/generation/canvas-actions"
import { useContextWorkbenchInstanceId } from "@/hooks/context-workbench/use-context-workbench-instance-id"
import { resolveContextCapabilities } from "@/lib/context-workbench/capabilities"
import { useContextCommentBadge } from "@/hooks/context-workbench/use-context-comment-badge"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

/**
 * Container-width threshold (driven by a ResizeObserver on the side-panel
 * frame) at which the tab labels collapse to icon-only. Intentionally
 * distinct from `useIsMobile()`'s 768 px viewport threshold — even on a
 * wide viewport the right rail can be narrow when the user has both
 * rails uncollapsed, so the icon-only swap is local to this panel rather
 * than mirroring the global mobile breakpoint.
 */
export const CANVAS_SIDE_PANELS_ICON_ONLY_BREAKPOINT = 280

export interface CanvasSidePanelsProps {
  mobile?: boolean
  /**
   * The shell has shrunk this column to the activity rail. Only the Workbench
   * surface honours it — the legacy rail predates the persistent minibar and
   * exists solely as a one-release rollback path.
   */
  railOnly?: boolean
}

export function CanvasSidePanels({ mobile = false, railOnly = false }: CanvasSidePanelsProps) {
  const enabled = useContextWorkbenchSurfaceFlag("canvas")
  return enabled ? (
    <CanvasContextWorkbench mobile={mobile} railOnly={railOnly} />
  ) : (
    <LegacyCanvasSidePanels />
  )
}

function CanvasContextWorkbench({ mobile, railOnly }: { mobile: boolean; railOnly: boolean }) {
  const tWorkbench = useTranslations("contextWorkbench")
  const workbenchInstanceId = useContextWorkbenchInstanceId("canvas")
  const activeId = useArtifactStore((state) => state.activeCanvasId)
  const documents = useArtifactStore((state) => state.canvasDocuments)
  const getCanvasVersions = useArtifactStore((state) => state.getCanvasVersions)
  const pendingReview = useArtifactStore((state) =>
    activeId ? (state.pendingReviews[activeId] ?? null) : null
  )
  const hadPendingReview = useRef(false)
  const activeRightTab = useCanvasLayoutStore((state) => state.activeRightTab)
  const setRightCollapsed = useCanvasLayoutStore((state) => state.setRightCollapsed)
  const setMobileRightOpen = useCanvasLayoutStore((state) => state.setMobileRightOpen)
  // `resetLayout` had lived on the store with no caller since it was written,
  // so a canvas shell dragged to an unusable split had no way back. Same entry
  // point as the chat dock's, in the workbench header's layout menu.
  const resetCanvasLayout = useCanvasLayoutStore((state) => state.resetLayout)
  const navigatePanel = useContextWorkbenchStore((state) => state.navigatePanel)
  const smartReveal = useContextWorkbenchStore((state) => state.smartReveal)
  const layouts = useContextWorkbenchStore((state) => state.layouts)
  const document = activeId ? documents[activeId] : undefined
  const unresolvedCommentCount = useContextCommentBadge("canvas-document", activeId)
  const scopeKey = activeId ? `${workbenchInstanceId}::canvas:${activeId}` : null
  const [selectionState, setSelectionState] = useState<
    { documentId: string; start: number; end: number } | undefined
  >()
  const textSelection = useMemo(
    () =>
      selectionState?.documentId === activeId
        ? { start: selectionState.start, end: selectionState.end }
        : undefined,
    [activeId, selectionState]
  )

  useEffect(() => {
    const handleSelection = (event: Event) => {
      const detail = (event as CustomEvent<{ documentId: string; start: number; end: number }>)
        .detail
      if (!activeId || detail.documentId !== activeId) return
      setSelectionState(detail.start === detail.end ? undefined : detail)
    }
    window.addEventListener("canvas-context-selection", handleSelection)
    return () => window.removeEventListener("canvas-context-selection", handleSelection)
  }, [activeId])

  useEffect(() => {
    if (!scopeKey || layouts[scopeKey]?.activePanelId) return
    navigatePanel(scopeKey, activeRightTab, "narrow")
  }, [activeRightTab, layouts, navigatePanel, scopeKey])

  useEffect(() => {
    const appeared = !hadPendingReview.current && pendingReview !== null
    hadPendingReview.current = pendingReview !== null
    if (appeared && scopeKey) {
      smartReveal(scopeKey, "proposal-review", "wide")
    }
  }, [pendingReview, scopeKey, smartReveal])

  const panels = useMemo<ContextPanelDefinition[]>(
    () => [
      {
        id: "ai-actions",
        activity: "ai",
        labelKey: "contextWorkbench.aiActions",
        icon: Wand2,
        order: 1,
        appliesTo: (resource) => resource.kind === "canvas-document",
        retention: "stateful",
        renderer: () => <CanvasWorkbenchActions />,
      },
      {
        id: "resource-chat",
        activity: "ai",
        labelKey: "contextWorkbench.resourceChat",
        icon: Lightbulb,
        order: 5,
        appliesTo: (resource) => resource.kind === "canvas-document",
        retention: "stateful",
        requiresChatScope: true,
        renderer: () => (
          <ResourceWorkbenchChatPanel getResourceContext={() => document?.content ?? ""} />
        ),
      },
      {
        id: "suggestions",
        activity: "ai",
        labelKey: "canvas.panels.suggestions",
        icon: Lightbulb,
        order: 10,
        appliesTo: (resource) => resource.kind === "canvas-document",
        retention: "stateful",
        getBadge: () =>
          (document?.aiSuggestions ?? []).filter((suggestion) => suggestion.status === "pending")
            .length,
        renderer: () => (activeId ? <SuggestionsHost documentId={activeId} /> : null),
      },
      {
        id: "comments",
        activity: "comments",
        labelKey: "canvas.panels.comments",
        icon: MessageSquare,
        order: 20,
        appliesTo: (resource) => resource.kind === "canvas-document",
        retention: "stateful",
        getBadge: () => unresolvedCommentCount,
        renderer: () =>
          activeId && document ? (
            <ContextCommentsPanel
              resource={{
                kind: "canvas-document",
                id: activeId,
                projectId: document.projectId,
              }}
              revision={document.currentVersionId ?? document.updatedAt.toISOString()}
              anchor={
                textSelection
                  ? {
                      kind: "text-range",
                      start: textSelection.start,
                      end: textSelection.end,
                      revision: document.currentVersionId ?? document.updatedAt.toISOString(),
                    }
                  : undefined
              }
            />
          ) : null,
      },
      {
        id: "collaboration",
        activity: "comments",
        labelKey: "canvas.panels.collaboration",
        icon: Users,
        order: 30,
        appliesTo: (resource) => resource.kind === "canvas-document",
        retention: "stateful",
        renderer: () => (activeId ? <CollaborationHost documentId={activeId} /> : null),
      },
      {
        id: "properties",
        activity: "inspect",
        labelKey: "contextWorkbench.metadata.canvasTitle",
        icon: InfoIcon,
        order: 35,
        appliesTo: (resource) => resource.kind === "canvas-document",
        retention: "stateful",
        renderer: () =>
          document ? (
            <div className="flex h-full min-h-0 flex-col">
              <div className="flex items-center border-b p-2">
                <CanvasLanguageSelect documentId={activeId} />
              </div>
              {document.type === "text" ? (
                <div className="border-b p-2">
                  <DocumentFormatToolbar
                    onAction={(action) =>
                      window.dispatchEvent(
                        new CustomEvent<{ action: FormatAction }>("canvas-format", {
                          detail: { action },
                        })
                      )
                    }
                    className="border-0 bg-transparent p-0 justify-start"
                  />
                </div>
              ) : null}
              <ContextMetadataPanel
                title={tWorkbench("metadata.canvasTitle")}
                fields={[
                  { label: tWorkbench("metadata.language"), value: document.language },
                  { label: tWorkbench("metadata.documentType"), value: document.type },
                  {
                    label: tWorkbench("metadata.saveState"),
                    value: document.editorContext?.saveState ?? tWorkbench("metadata.unknown"),
                  },
                  {
                    label: tWorkbench("metadata.revision"),
                    value: document.currentVersionId ?? tWorkbench("metadata.unknown"),
                  },
                  {
                    label: tWorkbench("metadata.updatedAt"),
                    value: document.updatedAt.toLocaleString(),
                  },
                ]}
              />
            </div>
          ) : null,
      },
      {
        id: "outline",
        activity: "inspect",
        labelKey: "canvas.panels.outline",
        icon: ListTree,
        order: 40,
        appliesTo: (resource) => resource.kind === "canvas-document",
        retention: "stateful",
        getBadge: () => countCanvasSymbols(parseCanvasSymbols(document)),
        renderer: () => (activeId ? <CanvasOutlinePanel documentId={activeId} /> : null),
      },
      {
        id: "proposal-review",
        activity: "review",
        labelKey: "contextWorkbench.proposalReview",
        icon: HistoryIcon,
        order: 45,
        appliesTo: (resource) => resource.kind === "canvas-document",
        retention: "stateful",
        preferredMode: "wide",
        getBadge: () => (pendingReview ? 1 : 0),
        renderer: () =>
          activeId ? <CanvasReviewView documentId={activeId} panelMode="desktop" /> : null,
      },
      {
        id: "history",
        activity: "review",
        labelKey: "canvas.panels.history",
        icon: HistoryIcon,
        order: 44,
        appliesTo: (resource) => resource.kind === "canvas-document",
        retention: "stateful",
        preferredMode: "wide",
        getBadge: () => (activeId ? getCanvasVersions(activeId).length : 0),
        renderer: () => (activeId ? <HistoryHost documentId={activeId} /> : null),
      },
      {
        id: "preview",
        activity: "preview-run",
        labelKey: "canvas.previewAction",
        icon: Eye,
        order: 50,
        appliesTo: (resource) => resource.kind === "canvas-document",
        retention: "stateful",
        preferredMode: "wide",
        renderer: () =>
          activeId ? (
            <div className="flex h-full min-h-0 flex-col">
              <div className="flex h-10 shrink-0 items-center justify-end border-b px-2">
                <CanvasExportMenu documentId={activeId} />
              </div>
              <CanvasPreviewPane documentId={activeId} className="min-h-0 flex-1" />
            </div>
          ) : null,
      },
      {
        id: "execution",
        activity: "preview-run",
        labelKey: "canvas.panels.execution",
        icon: Play,
        order: 60,
        appliesTo: (resource) => resource.kind === "canvas-document",
        retention: "stateful",
        preferredMode: "wide",
        renderer: () => (activeId ? <ExecutionHost documentId={activeId} /> : null),
      },
    ],
    [
      activeId,
      document,
      getCanvasVersions,
      pendingReview,
      tWorkbench,
      textSelection,
      unresolvedCommentCount,
    ]
  )

  if (!activeId || !document) return <LegacyCanvasSidePanels />

  const resource: ContextResource = {
    kind: "canvas-document",
    documentId: activeId,
    revision: document.currentVersionId ?? document.updatedAt.toISOString(),
    selection: textSelection
      ? { kind: "canvas", blockIds: [], text: { kind: "text", ...textSelection } }
      : undefined,
    capabilities: resolveContextCapabilities({
      kind: "canvas-document",
      runnable: document.type === "code",
    }),
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PluginExtensionSlot
        point="canvas.sidebar"
        className="flex flex-col gap-1 border-b bg-muted/20 px-2 py-1 empty:hidden"
      />
      <ContextWorkbench
        workbenchInstanceId={workbenchInstanceId}
        resource={resource}
        panels={panels}
        onCollapse={() => (mobile ? setMobileRightOpen(false) : setRightCollapsed(true))}
        onEnsureVisible={() => (mobile ? setMobileRightOpen(true) : setRightCollapsed(false))}
        railOnly={mobile ? false : railOnly}
        onResetLayout={resetCanvasLayout}
        placement={mobile ? "mobile-sheet" : "adjacent-editor"}
        manageOwnWidth={false}
        className="w-full flex-1"
      />
    </div>
  )
}

function CanvasWorkbenchActions() {
  const t = useTranslations("canvas.actions")
  const dispatchAction = (type: CanvasActionType, targetLanguage?: string) => {
    window.dispatchEvent(
      new CustomEvent("canvas-action", {
        detail: { type, targetLanguage, proposalFirst: true },
      })
    )
  }

  return (
    <div className="grid gap-2 p-3">
      <Button variant="outline" className="justify-start" onClick={() => dispatchAction("review")}>
        <Wand2 className="mr-2 size-4" />
        {t("review")}
      </Button>
      <Button variant="outline" className="justify-start" onClick={() => dispatchAction("fix")}>
        <Bug className="mr-2 size-4" />
        {t("fix")}
      </Button>
      <Button variant="outline" className="justify-start" onClick={() => dispatchAction("improve")}>
        <Sparkles className="mr-2 size-4" />
        {t("improve")}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" className="justify-start">
            <Languages className="mr-2 size-4" />
            {t("translate")}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start">
          {TRANSLATE_LANGUAGES.map((language) => (
            <DropdownMenuItem
              key={language.value}
              onClick={() => dispatchAction("translate", language.value)}
            >
              {language.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <Button variant="outline" className="justify-start" onClick={() => dispatchAction("explain")}>
        <HelpCircle className="mr-2 size-4" />
        {t("explain")}
      </Button>
      <Button
        variant="outline"
        className="justify-start"
        onClick={() => dispatchAction("simplify")}
      >
        <Minimize2 className="mr-2 size-4" />
        {t("simplify")}
      </Button>
      <Button variant="outline" className="justify-start" onClick={() => dispatchAction("expand")}>
        <Expand className="mr-2 size-4" />
        {t("expand")}
      </Button>
      <Button
        variant="outline"
        className="justify-start"
        onClick={() => window.dispatchEvent(new CustomEvent("canvas-action-suggest"))}
      >
        <Lightbulb className="mr-2 size-4" />
        {t("suggest", { default: "Suggest" })}
      </Button>
    </div>
  )
}

function LegacyCanvasSidePanels() {
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
  const getCommentsForDocument = useCommentStore((s) => s.getCommentsForDocument)

  const tabBadges = useMemo(() => {
    const doc = documents[activeId ?? ""]
    const suggestions = doc?.aiSuggestions ?? []
    const versions = getCanvasVersions(activeId ?? "")
    const comments = getCommentsForDocument(activeId ?? "")
    return {
      suggestions: suggestions.filter((s) => s.status === "pending").length,
      history: versions.length,
      comments: comments.filter((c: { resolvedAt?: unknown }) => c.resolvedAt == null).length,
      collaboration: 0,
      execution: 0,
      outline: countCanvasSymbols(parseCanvasSymbols(doc)),
    }
  }, [activeId, documents, getCanvasVersions, getCommentsForDocument])

  if (!activeId) {
    return (
      <div ref={containerRef} className="flex h-full min-h-0 min-w-0 flex-col">
        <Empty className="border-0 p-4 text-xs">
          <EmptyHeader>
            <EmptyDescription className="text-xs">{t("emptyHint")}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    )
  }

  // Wrap each tab's host in a motion container so the rail fades + stagger
  // animates rather than snapping when the user switches tabs. Radix already
  // unmounts inactive TabsContent, so AnimatePresence + per-tab key drives
  // both the enter animation and the underlying stagger.
  const tabContentMotionProps = {
    variants: STAGGER_CONTAINER,
    initial: "initial",
    animate: "animate",
    exit: "exit",
    transition: mobileTransition("fast"),
    className: "h-full",
  } as const

  return (
    <div ref={containerRef} className="flex h-full min-h-0 min-w-0 flex-col">
      <PluginExtensionSlot
        point="canvas.sidebar"
        className="flex flex-col gap-1 border-b bg-muted/20 px-2 py-1 empty:hidden"
      />
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
          <PanelTab
            value="outline"
            icon={<ListTree className="size-3.5" />}
            label={t("outline", { default: "Outline" })}
            iconOnly={iconOnly}
            badge={tabBadges.outline}
          />
        </TabsList>

        <AnimatePresence mode="wait" initial={false}>
          <TabsContent
            key="suggestions"
            value="suggestions"
            className="m-0 flex-1 min-h-0 overflow-hidden"
          >
            <motion.div
              key="suggestions"
              data-testid="canvas-tab-motion-suggestions"
              {...tabContentMotionProps}
            >
              <SuggestionsHost documentId={activeId} />
            </motion.div>
          </TabsContent>
          <TabsContent key="history" value="history" className="m-0 flex-1 min-h-0 overflow-hidden">
            <motion.div
              key="history"
              data-testid="canvas-tab-motion-history"
              {...tabContentMotionProps}
            >
              <HistoryHost documentId={activeId} />
            </motion.div>
          </TabsContent>
          <TabsContent
            key="comments"
            value="comments"
            className="m-0 flex-1 min-h-0 overflow-hidden"
          >
            <motion.div
              key="comments"
              data-testid="canvas-tab-motion-comments"
              {...tabContentMotionProps}
            >
              <CommentsHost documentId={activeId} />
            </motion.div>
          </TabsContent>
          <TabsContent
            key="collaboration"
            value="collaboration"
            className="m-0 flex-1 min-h-0 overflow-hidden"
          >
            <motion.div
              key="collaboration"
              data-testid="canvas-tab-motion-collaboration"
              {...tabContentMotionProps}
            >
              <CollaborationHost documentId={activeId} />
            </motion.div>
          </TabsContent>
          <TabsContent
            key="execution"
            value="execution"
            className="m-0 flex-1 min-h-0 overflow-hidden"
          >
            <motion.div
              key="execution"
              data-testid="canvas-tab-motion-execution"
              {...tabContentMotionProps}
            >
              <ExecutionHost documentId={activeId} />
            </motion.div>
          </TabsContent>
          <TabsContent key="outline" value="outline" className="m-0 flex-1 min-h-0 overflow-hidden">
            <motion.div
              key="outline"
              data-testid="canvas-tab-motion-outline"
              {...tabContentMotionProps}
            >
              <CanvasOutlinePanel documentId={activeId} />
            </motion.div>
          </TabsContent>
        </AnimatePresence>
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
          <Badge
            variant="default"
            className="ml-0.5 h-3.5 min-w-[14px] rounded-full px-1 py-0 text-[9px] font-medium leading-none"
          >
            {badge > 99 ? "99+" : badge}
          </Badge>
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
      <Empty className="h-full border-0">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Lightbulb />
          </EmptyMedia>
          <EmptyDescription className="text-xs">{t("suggestionsEmpty")}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }
  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      <SuggestionsPanel documentId={documentId} suggestions={suggestions} proposalFirst />
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
      <Empty className="h-full border-0">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <HistoryIcon />
          </EmptyMedia>
          <EmptyDescription className="text-xs">{t("historyEmpty")}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  const recent = versions.slice(0, 3)

  return (
    <div className="flex h-full flex-col">
      <motion.div
        className="flex-1 min-h-0 overflow-y-auto p-3 space-y-1"
        variants={STAGGER_CONTAINER}
        initial="initial"
        animate="animate"
      >
        {recent.map((v) => (
          <motion.div
            key={v.id}
            variants={STAGGER_CHILD}
            className="flex items-center gap-2 text-xs text-muted-foreground py-1"
          >
            <span className="truncate flex-1">
              {v.description || new Date(v.createdAt).toLocaleString()}
            </span>
            {v.isAutoSave && (
              <Badge variant="outline" className="text-[9px] px-1 h-4 shrink-0">
                <AutoSaveTag />
              </Badge>
            )}
          </motion.div>
        ))}
        {versions.length > 3 && (
          <p className="text-[10px] text-muted-foreground/60 pt-1">
            {t("moreVersions", { count: versions.length - 3 })}
          </p>
        )}
      </motion.div>
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

function AutoSaveTag() {
  const tRoot = useTranslations("canvas")
  return <>{tRoot("autoTag")}</>
}

/**
 * Renders the Cognia CommentPanel inside a Sheet trigger button.
 */
function CommentsHost({ documentId }: { documentId: string }) {
  const t = useTranslations("canvas.panels")
  const getCommentsForDocument = useCommentStore((s) => s.getCommentsForDocument)
  const comments = getCommentsForDocument(documentId)
  const unresolved = comments.filter((c) => c.resolvedAt == null)

  if (comments.length === 0) {
    return (
      <Empty className="h-full border-0">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <MessageSquare />
          </EmptyMedia>
          <EmptyDescription className="text-xs">{t("commentsEmpty")}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    )
  }

  return (
    <div className="space-y-2 p-3">
      <p className="text-xs text-muted-foreground">
        {t("commentsSummary", { count: comments.length, unresolved: unresolved.length })}
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
  // Feature-flag gate: `canvas.collaboration.v1` (env / localStorage override).
  // When disabled, the panel shows the hint but no "open collaboration" entry.
  const collaborationEnabled = useCanvasFeatureFlag("canvas.collaboration.v1")
  const documents = useArtifactStore((s) => s.canvasDocuments)
  const doc = documents[documentId]
  return (
    <Empty className="h-full border-0">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Users />
        </EmptyMedia>
        <EmptyDescription className="text-xs">{t("collabHint")}</EmptyDescription>
      </EmptyHeader>
      {collaborationEnabled && (
        <EmptyContent>
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
        </EmptyContent>
      )}
    </Empty>
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
