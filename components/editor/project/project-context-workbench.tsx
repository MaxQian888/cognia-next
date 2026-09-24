"use client"

import { useEffect, useMemo, useRef, useSyncExternalStore } from "react"
import {
  BotIcon,
  FileSearchIcon,
  GitCompareIcon,
  ListTreeIcon,
  MessageSquareIcon,
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
 * The project editor's secondary sidebar: per-file AI (a resource-scoped chat
 * whose replies land as reviewable proposals), comments, inspect, outline and
 * the proposal review itself. Preview, problems and the Git diff are the
 * editor's own surfaces (the preview overlay, the Problems panel, the dock's
 * Review surface) and deliberately not duplicated here.
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
}: {
  scopeKey: string
  rootPath: string
  file: OpenFile
  onDraftChange: (content: string) => void
  selection?: TextSelectionCoordinates
  railOnly: boolean
  onCollapse: () => void
  onEnsureVisible: () => void
  /** Narrow/wide requests; see `ContextWorkbench`'s `onModeWidthHint`. */
  onModeWidthHint: (mode: ContextPanelMode, panelId?: string) => void
  /** The preset the host's panel actually sits at, once measured. */
  resolvedMode?: ContextPanelMode
}) {
  return (
    <ProjectContextWorkbenchHost
      scopeKey={scopeKey}
      rootPath={rootPath}
      file={file}
      onDraftChange={onDraftChange}
      selection={selection}
      desktop={{ railOnly, onCollapse, onEnsureVisible, onModeWidthHint, resolvedMode }}
    />
  )
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
  file: OpenFile
  mobile?: { open: boolean; onOpenChange: (open: boolean) => void }
  desktop?: {
    railOnly: boolean
    onCollapse: () => void
    onEnsureVisible: () => void
    onModeWidthHint: (mode: ContextPanelMode, panelId?: string) => void
    resolvedMode?: ContextPanelMode
  }
  onDraftChange: (content: string) => void
  selection?: TextSelectionCoordinates
}) {
  const workbenchInstanceId = useContextWorkbenchInstanceId(`project:${scopeKey}`)
  const t = useTranslations("projectEditor.workbench")
  const dirty = file.draftContent !== file.savedContent
  const hash = contentToken(file.draftContent)
  const latestFile = useRef(file)
  useEffect(() => {
    latestFile.current = file
  }, [file])
  const resourceKey = getProjectFileResourceKey({
    projectId: scopeKey,
    rootId: rootPath,
    relPath: file.relPath,
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
  const layoutScopeKey = `${workbenchInstanceId}::project:${scopeKey}:${rootPath}:${file.relPath}`

  useEffect(
    () =>
      registerProjectFileProposalAdapter(resourceKey, {
        capture: () => ({
          content: latestFile.current.draftContent,
          baseToken: fileBaseToken(latestFile.current),
        }),
        apply: (content, expectedBaseToken) => {
          if (fileBaseToken(latestFile.current) !== expectedBaseToken) return false
          const nextDraftVersion = latestFile.current.draftVersion + 1
          latestFile.current = {
            ...latestFile.current,
            draftContent: content,
            draftVersion: nextDraftVersion,
          }
          onDraftChange(content)
          return `${nextDraftVersion}:0:${contentToken(content)}`
        },
      }),
    [onDraftChange, resourceKey]
  )

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
  useEffect(() => {
    if (activePanelId) return
    navigatePanel(layoutScopeKey, "ai", "narrow")
  }, [activePanelId, layoutScopeKey, navigatePanel])

  const panels = useMemo<ContextPanelDefinition[]>(
    () => [
      {
        id: "ai",
        activity: "ai",
        labelKey: "projectEditor.workbench.ai",
        icon: BotIcon,
        order: 10,
        appliesTo: (resource) => resource.kind === "project-file",
        retention: "stateful",
        requiresChatScope: true,
        renderer: () => (
          <ResourceWorkbenchChatPanel getResourceContext={() => file.draftContent ?? ""} />
        ),
      },
      {
        id: "comments",
        activity: "comments",
        labelKey: "projectEditor.workbench.comments",
        icon: MessageSquareIcon,
        order: 20,
        appliesTo: (resource) => resource.kind === "project-file",
        retention: "stateful",
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
        id: "inspect",
        activity: "inspect",
        labelKey: "projectEditor.workbench.inspect",
        icon: FileSearchIcon,
        order: 30,
        appliesTo: (resource) => resource.kind === "project-file",
        retention: "stateful",
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
        id: "outline",
        activity: "inspect",
        labelKey: "projectEditor.workbench.outline",
        icon: ListTreeIcon,
        order: 31,
        appliesTo: (resource) => resource.kind === "project-file",
        retention: "stateful",
        renderer: () => (
          <ProjectFileOutlinePanel
            relPath={file.relPath}
            language={file.language}
            content={file.draftContent ?? ""}
          />
        ),
      },
      {
        id: "proposal-review",
        activity: "review",
        labelKey: "contextWorkbench.proposalReview",
        icon: GitCompareIcon,
        order: 40,
        appliesTo: (resource) => resource.kind === "project-file",
        retention: "stateful",
        preferredMode: "wide",
        getBadge: () => (proposal ? 1 : 0),
        renderer: () => <ProjectFileReviewPanel resourceKey={resourceKey} />,
      },
    ],
    [
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
    ]
  )

  const resource: ContextResource = {
    kind: "project-file",
    projectId: scopeKey,
    rootId: rootPath,
    relPath: file.relPath,
    contentHash: hash,
    mtime: file.mtime,
    draftVersion: file.draftVersion,
    selection,
    capabilities: resolveContextCapabilities({
      kind: "project-file",
      previewable: isProjectFilePreviewable(file.relPath),
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
      // The host's resizable panel draws the divider; a second border beside
      // it would read as a double rule.
      className="w-full border-l-0"
    />
  )
}
