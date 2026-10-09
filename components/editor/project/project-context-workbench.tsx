"use client"

import { useEffect, useMemo, useRef, useSyncExternalStore, type ReactNode } from "react"
import {
  BotIcon,
  FileSearchIcon,
  FilesIcon,
  GitCompareIcon,
  ListTreeIcon,
  MessageSquareIcon,
  SearchIcon,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { ContextWorkbench } from "@/components/context-workbench/context-workbench"
import { ContextWorkbenchMobileDrawer } from "@/components/context-workbench/context-workbench"
import type { OpenFile } from "./use-project-editor"
import type {
  ContextPanelDefinition,
  ContextPanelMode,
  ContextResource,
  TextSelectionCoordinates,
} from "@/types/context-workbench"
import { ResourceWorkbenchChatPanel } from "@/components/context-workbench/resource-workbench-chat-panel"
import { ContextCommentsPanel } from "@/components/context-workbench/context-comments-panel"
import { ProjectFileReviewPanel } from "./project-file-review-panel"
import { ProjectResourceSessionRelinker } from "./project-resource-session-relinker"
import { ProjectFileOutlinePanel } from "./project-file-outline-panel"
import {
  getProjectFileResourceKey,
  getProjectFileProposal,
  registerProjectFileProposalAdapter,
  subscribeProjectFileProposals,
} from "@/lib/context-workbench/project-file-proposals"
import { useContextWorkbenchStore } from "@/stores/context-workbench/context-workbench-store"
import { useContextWorkbenchInstanceId } from "@/hooks/context-workbench/use-context-workbench-instance-id"
import {
  isProjectFilePreviewable,
  resolveContextCapabilities,
} from "@/lib/context-workbench/capabilities"
import { useContextCommentBadge } from "@/hooks/context-workbench/use-context-comment-badge"
import { EDITOR_TITLE_ROW_CLASS } from "./editor-chrome"

function contentToken(content: string | undefined | null): string {
  const text = content ?? ""
  let hash = 2166136261
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16)
}

function fileBaseToken(file: OpenFile): string {
  return `${file.draftVersion}:${file.mtime ?? "unknown"}:${file.externallyChanged ? 1 : 0}:${contentToken(file.draftContent)}`
}

/**
 * The project editor's one sidebar. Its project views — Files and Search, the
 * explorer VS Code keeps on the left — lead it, and the open file's views
 * follow as peers: per-file AI (a resource-scoped chat whose replies land as
 * reviewable proposals), comments, inspect, outline and the proposal review.
 * Preview, problems and the Git diff are the editor's own surfaces (the preview
 * overlay, the Problems panel, the dock's Review surface) and deliberately not
 * duplicated here.
 *
 * It is mounted whether or not a file is open (`file: null` keeps every view on
 * the rail; the file views then ask for a file), and its layout — which view is in front, which tabs are
 * open — is one per project root, not one per file: opening or switching files
 * never moves the sidebar off the view the user picked, nor resizes it.
 *
 * The host owns open/closed and width: `railOnly` draws the activity rail
 * alone, `onCollapse` / `onEnsureVisible` are the rail's close and open
 * requests, and `onModeWidthHint` carries narrow/wide requests to the panel
 * the host sizes it with — the editor lives in the chat's right dock, where a
 * self-sized 360–960px sidebar would crowd the editor out.
 */
export function ProjectContextWorkbench({
  scopeKey,
  rootPath,
  file,
  onDraftChange,
  selection,
  railOnly,
  onCollapse,
  onEnsureVisible,
  onModeWidthHint,
  resolvedMode,
  projectViews,
  revealRequest,
  onActivePanelChange,
}: {
  scopeKey: string
  rootPath: string
  /** The focused group's file; null while nothing is open. */
  file: OpenFile | null
  onDraftChange: (content: string) => void
  selection?: TextSelectionCoordinates
  railOnly: boolean
  onCollapse: () => void
  onEnsureVisible: () => void
  /** Narrow/wide requests; see `ContextWorkbench`'s `onModeWidthHint`. */
  onModeWidthHint: (mode: ContextPanelMode, panelId?: string) => void
  /** The preset the host's panel actually sits at, once measured. */
  resolvedMode?: ContextPanelMode
  /** The explorer and project search, rendered by the editor (kept alive across folds). */
  projectViews: ProjectViews
  /** Bring a panel to the front (⌘B, ⇧⌘F, reveal in explorer, the selection toolbar). */
  revealRequest?: { panelId: string; seq: number }
  /** The panel in front changed — the editor mirrors it (explorer visibility, ⌘B). */
  onActivePanelChange?: (panelId: string | null) => void
}) {
  return (
    <ProjectContextWorkbenchHost
      scopeKey={scopeKey}
      rootPath={rootPath}
      file={file}
      onDraftChange={onDraftChange}
      selection={selection}
      desktop={{
        railOnly,
        onCollapse,
        onEnsureVisible,
        onModeWidthHint,
        resolvedMode,
        projectViews,
        revealRequest,
        onActivePanelChange,
      }}
    />
  )
}

/** Panel ids of the project views — also what the editor's commands reveal. */
export const PROJECT_FILES_PANEL_ID = "files"
export const PROJECT_SEARCH_PANEL_ID = "search"
/**
 * Their activities. Host-local (not in the canonical, plugin-facing taxonomy)
 * and pinned ahead of the file views through `leadingActivities`.
 */
const PROJECT_FILES_ACTIVITY = "project-files"
const PROJECT_SEARCH_ACTIVITY = "project-search"
const PROJECT_LEADING_ACTIVITIES = [PROJECT_FILES_ACTIVITY, PROJECT_SEARCH_ACTIVITY] as const

/**
 * The open file's views. Their rail buttons stay put with no file to act on
 * (none open, or a binary/oversized one in front) — the rail never reshuffles
 * as files come and go — and their bodies say what they need instead.
 */
type FilePanelId = "ai" | "comments" | "inspect" | "outline" | "proposal-review"
const FILE_PANELS: Record<
  FilePanelId,
  Pick<ContextPanelDefinition, "id" | "activity" | "labelKey" | "icon" | "order" | "retention">
> = {
  ai: {
    id: "ai",
    activity: "ai",
    labelKey: "projectEditor.workbench.ai",
    icon: BotIcon,
    order: 10,
    retention: "stateful",
  },
  comments: {
    id: "comments",
    activity: "comments",
    labelKey: "projectEditor.workbench.comments",
    icon: MessageSquareIcon,
    order: 20,
    retention: "stateful",
  },
  inspect: {
    id: "inspect",
    activity: "inspect",
    labelKey: "projectEditor.workbench.inspect",
    icon: FileSearchIcon,
    order: 30,
    retention: "stateful",
  },
  outline: {
    id: "outline",
    activity: "inspect",
    labelKey: "projectEditor.workbench.outline",
    icon: ListTreeIcon,
    order: 31,
    retention: "stateful",
  },
  "proposal-review": {
    id: "proposal-review",
    activity: "review",
    labelKey: "contextWorkbench.proposalReview",
    icon: GitCompareIcon,
    order: 40,
    retention: "stateful",
  },
}

const appliesToProjectFile: ContextPanelDefinition["appliesTo"] = (resource) =>
  resource.kind === "project-file"

function NoFilePanel({ message }: { message: string }) {
  return (
    <div
      className="flex h-full items-center justify-center p-6 text-center text-xs text-muted-foreground"
      data-testid="project-context-no-file"
    >
      {message}
    </div>
  )
}

export interface ProjectViews {
  /** Renders the explorer in the panel's box (a parked-view slot). */
  files: () => ReactNode
  /** Renders project search in the panel's box. */
  search: () => ReactNode
}

export function ProjectContextWorkbenchMobile({
  scopeKey,
  rootPath,
  file,
  open,
  onOpenChange,
  onDraftChange,
  selection,
}: {
  scopeKey: string
  rootPath: string
  file: OpenFile
  open: boolean
  onOpenChange: (open: boolean) => void
  onDraftChange: (content: string) => void
  selection?: TextSelectionCoordinates
}) {
  return (
    <ProjectContextWorkbenchHost
      scopeKey={scopeKey}
      rootPath={rootPath}
      file={file}
      onDraftChange={onDraftChange}
      selection={selection}
      mobile={{ open, onOpenChange }}
    />
  )
}

function ProjectContextWorkbenchHost({
  scopeKey,
  rootPath,
  file,
  mobile,
  desktop,
  onDraftChange,
  selection,
}: {
  scopeKey: string
  rootPath: string
  file: OpenFile | null
  mobile?: { open: boolean; onOpenChange: (open: boolean) => void }
  desktop?: {
    railOnly: boolean
    onCollapse: () => void
    onEnsureVisible: () => void
    onModeWidthHint: (mode: ContextPanelMode, panelId?: string) => void
    resolvedMode?: ContextPanelMode
    projectViews: ProjectViews
    revealRequest?: { panelId: string; seq: number }
    onActivePanelChange?: (panelId: string | null) => void
  }
  onDraftChange: (content: string) => void
  selection?: TextSelectionCoordinates
}) {
  const workbenchInstanceId = useContextWorkbenchInstanceId(`project:${scopeKey}`)
  const t = useTranslations("projectEditor.workbench")
  const relPath = file?.relPath ?? ""
  const dirty = file ? file.draftContent !== file.savedContent : false
  const hash = contentToken(file?.draftContent)
  const latestFile = useRef(file)
  useEffect(() => {
    latestFile.current = file
  }, [file])
  const resourceKey = getProjectFileResourceKey({
    projectId: scopeKey,
    rootId: rootPath,
    relPath,
  })
  const unresolvedCommentCount = useContextCommentBadge("project-file", resourceKey)
  const proposal = useSyncExternalStore(
    subscribeProjectFileProposals,
    () => getProjectFileProposal(resourceKey),
    () => null
  )
  const navigatePanel = useContextWorkbenchStore((state) => state.navigatePanel)
  const smartReveal = useContextWorkbenchStore((state) => state.smartReveal)
  const hadProposal = useRef(false)
  // Desktop: one layout per project root, whatever file is open — the sidebar
  // keeps its view and width across files. The mobile drawer only carries file
  // views, so it keeps the workbench's own per-file scope.
  const projectLayoutScopeKey = `${workbenchInstanceId}::project-root:${scopeKey}:${rootPath}`
  const layoutScopeKey = desktop
    ? projectLayoutScopeKey
    : `${workbenchInstanceId}::project:${scopeKey}:${rootPath}:${relPath}`

  const hasFile = file !== null
  useEffect(() => {
    // No file, no draft to propose against.
    if (!hasFile) return
    return registerProjectFileProposalAdapter(resourceKey, {
      capture: () => {
        const current = latestFile.current
        return current
          ? { content: current.draftContent, baseToken: fileBaseToken(current) }
          : { content: "", baseToken: "" }
      },
      apply: (content, expectedBaseToken) => {
        const current = latestFile.current
        if (!current || fileBaseToken(current) !== expectedBaseToken) return false
        const nextDraftVersion = current.draftVersion + 1
        latestFile.current = { ...current, draftContent: content, draftVersion: nextDraftVersion }
        onDraftChange(content)
        return `${nextDraftVersion}:0:${contentToken(content)}`
      },
    })
  }, [hasFile, onDraftChange, resourceKey])

  // A proposal is the AI panel's answer — surface it even when the host has
  // the workbench folded to its rail, or the reply would land out of sight.
  // `smartReveal` only records the wide intent; the host owns the width, so
  // it is told as well (the chat dock does the same for artifact reviews).
  const ensureVisible = desktop?.onEnsureVisible
  const modeWidthHint = desktop?.onModeWidthHint
  useEffect(() => {
    const appeared = !hadProposal.current && proposal !== null
    hadProposal.current = proposal !== null
    if (!appeared) return
    ensureVisible?.()
    smartReveal(layoutScopeKey, "proposal-review", "wide")
    modeWidthHint?.("wide", "proposal-review")
  }, [ensureVisible, layoutScopeKey, modeWidthHint, proposal, smartReveal])

  // Parity with the artifact/canvas/workflow surfaces: activate a default panel
  // on first mount so the content pane is never empty next to the activity rail.
  const activePanelId = useContextWorkbenchStore(
    (state) => state.layouts[layoutScopeKey]?.activePanelId ?? null
  )
  // The desktop sidebar opens on the explorer (VS Code); the drawer on AI.
  const defaultPanelId = desktop ? PROJECT_FILES_PANEL_ID : "ai"
  useEffect(() => {
    if (activePanelId) return
    navigatePanel(layoutScopeKey, defaultPanelId, "narrow")
  }, [activePanelId, defaultPanelId, layoutScopeKey, navigatePanel])
  const onActivePanelChange = desktop?.onActivePanelChange
  useEffect(() => {
    onActivePanelChange?.(activePanelId)
  }, [activePanelId, onActivePanelChange])

  const projectViews = desktop?.projectViews
  const projectPanels = useMemo<ContextPanelDefinition[]>(
    () =>
      projectViews
        ? [
            {
              id: PROJECT_FILES_PANEL_ID,
              activity: PROJECT_FILES_ACTIVITY,
              labelKey: "projectEditor.filesTab",
              icon: FilesIcon,
              order: 0,
              appliesTo: (resource) => resource.kind === "project-file",
              retention: "stateful",
              renderer: projectViews.files,
            },
            {
              id: PROJECT_SEARCH_PANEL_ID,
              activity: PROJECT_SEARCH_ACTIVITY,
              labelKey: "projectEditor.searchTab",
              icon: SearchIcon,
              order: 0,
              appliesTo: (resource) => resource.kind === "project-file",
              retention: "stateful",
              renderer: projectViews.search,
            },
          ]
        : [],
    [projectViews]
  )

  const filePanels = useMemo<ContextPanelDefinition[]>(() => {
    if (!file) {
      const noFile = () => <NoFilePanel message={t("noFile")} />
      return Object.values(FILE_PANELS).map((panel) => ({
        ...panel,
        appliesTo: appliesToProjectFile,
        renderer: noFile,
      }))
    }
    return [
      {
        ...FILE_PANELS.ai,
        appliesTo: appliesToProjectFile,
        requiresChatScope: true,
        renderer: () => (
          <ResourceWorkbenchChatPanel getResourceContext={() => file.draftContent ?? ""} />
        ),
      },
      {
        ...FILE_PANELS.comments,
        appliesTo: appliesToProjectFile,
        getBadge: () => unresolvedCommentCount,
        renderer: () => (
          <ContextCommentsPanel
            resource={{ kind: "project-file", id: resourceKey, projectId: scopeKey }}
            revision={fileBaseToken(file)}
            anchor={
              selection
                ? {
                    kind: "text-range",
                    start: selection.start,
                    end: selection.end,
                    revision: fileBaseToken(file),
                  }
                : undefined
            }
          />
        ),
      },
      {
        ...FILE_PANELS.inspect,
        appliesTo: appliesToProjectFile,
        renderer: () => (
          <div className="workbench-scroll h-full overflow-auto">
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-2 p-4 text-xs">
              <dt className="text-muted-foreground">{t("path")}</dt>
              <dd className="break-all">{file.relPath}</dd>
              <dt className="text-muted-foreground">{t("language")}</dt>
              <dd>{file.language}</dd>
              <dt className="text-muted-foreground">{t("state")}</dt>
              <dd>{dirty ? t("dirty") : t("saved")}</dd>
              <dt className="text-muted-foreground">{t("contentHash")}</dt>
              <dd className="font-mono">{hash}</dd>
            </dl>
            <ProjectResourceSessionRelinker
              resourceKey={resourceKey}
              projectId={scopeKey}
              rootId={rootPath}
              relPath={file.relPath}
            />
          </div>
        ),
      },
      {
        ...FILE_PANELS.outline,
        appliesTo: appliesToProjectFile,
        renderer: () => (
          <ProjectFileOutlinePanel
            relPath={file.relPath}
            language={file.language}
            content={file.draftContent ?? ""}
          />
        ),
      },
      {
        ...FILE_PANELS["proposal-review"],
        appliesTo: appliesToProjectFile,
        preferredMode: "wide",
        getBadge: () => (proposal ? 1 : 0),
        renderer: () => <ProjectFileReviewPanel resourceKey={resourceKey} />,
      },
    ]
  }, [
    dirty,
    file,
    hash,
    proposal,
    resourceKey,
    rootPath,
    scopeKey,
    selection,
    t,
    unresolvedCommentCount,
  ])
  const panels = useMemo(() => [...projectPanels, ...filePanels], [filePanels, projectPanels])

  // With no file open the resource is the project root (`relPath: ""`); the
  // file views stay on the rail with their no-file bodies.
  const resource: ContextResource = {
    kind: "project-file",
    projectId: scopeKey,
    rootId: rootPath,
    relPath,
    contentHash: hash,
    mtime: file?.mtime,
    draftVersion: file?.draftVersion ?? 0,
    selection,
    capabilities: resolveContextCapabilities({
      kind: "project-file",
      previewable: file ? isProjectFilePreviewable(file.relPath) : false,
    }),
  }

  return mobile ? (
    <ContextWorkbenchMobileDrawer
      open={mobile.open}
      onOpenChange={mobile.onOpenChange}
      workbenchInstanceId={workbenchInstanceId}
      resource={resource}
      panels={panels}
    />
  ) : (
    <ContextWorkbench
      workbenchInstanceId={workbenchInstanceId}
      resource={resource}
      panels={panels}
      manageOwnWidth={false}
      railOnly={desktop?.railOnly}
      onCollapse={desktop?.onCollapse}
      onEnsureVisible={desktop?.onEnsureVisible}
      onModeWidthHint={desktop?.onModeWidthHint}
      resolvedMode={desktop?.resolvedMode}
      leadingActivities={PROJECT_LEADING_ACTIVITIES}
      layoutScopeKey={projectLayoutScopeKey}
      revealRequest={desktop?.revealRequest}
      headerClassName={EDITOR_TITLE_ROW_CLASS}
      // The host's resizable panel draws the divider; a second border beside
      // it would read as a double rule.
      className="w-full border-l-0"
    />
  )
}
