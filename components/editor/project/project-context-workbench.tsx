"use client"

import { useEffect, useMemo, useRef, useSyncExternalStore } from "react"
import {
  BotIcon,
  EyeIcon,
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
  ContextResource,
  TextSelectionCoordinates,
} from "@/types/context-workbench"
import { ResourceWorkbenchChatPanel } from "@/components/context-workbench/resource-workbench-chat-panel"
import { ContextCommentsPanel } from "@/components/context-workbench/context-comments-panel"
import { ProjectFileReviewPanel } from "./project-file-review-panel"
import { ProjectGitReviewPanel } from "./project-git-review-panel"
import { ProjectFilePreviewPanel } from "./project-file-preview-panel"
import { ProjectResourceSessionRelinker } from "./project-resource-session-relinker"
import { ProjectFileOutlinePanel } from "./project-file-outline-panel"
import { MonacoDiagnosticsBar } from "@/components/editor/monaco-diagnostics-bar"
import type { EditorLike, MonacoLike } from "@/hooks/use-monaco-markers"
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

export function ProjectContextWorkbench({
  scopeKey,
  rootPath,
  file,
  onDraftChange,
  selection,
  diagnostics,
}: {
  scopeKey: string
  rootPath: string
  file: OpenFile
  onDraftChange: (content: string) => void
  selection?: TextSelectionCoordinates
  diagnostics?: { monaco: MonacoLike; editor: EditorLike } | null
}) {
  return (
    <ProjectContextWorkbenchHost
      scopeKey={scopeKey}
      rootPath={rootPath}
      file={file}
      onDraftChange={onDraftChange}
      selection={selection}
      diagnostics={diagnostics}
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
  diagnostics,
}: {
  scopeKey: string
  rootPath: string
  file: OpenFile
  open: boolean
  onOpenChange: (open: boolean) => void
  onDraftChange: (content: string) => void
  selection?: TextSelectionCoordinates
  diagnostics?: { monaco: MonacoLike; editor: EditorLike } | null
}) {
  return (
    <ProjectContextWorkbenchHost
      scopeKey={scopeKey}
      rootPath={rootPath}
      file={file}
      onDraftChange={onDraftChange}
      selection={selection}
      diagnostics={diagnostics}
      mobile={{ open, onOpenChange }}
    />
  )
}

function ProjectContextWorkbenchHost({
  scopeKey,
  rootPath,
  file,
  mobile,
  onDraftChange,
  selection,
  diagnostics,
}: {
  scopeKey: string
  rootPath: string
  file: OpenFile
  mobile?: { open: boolean; onOpenChange: (open: boolean) => void }
  onDraftChange: (content: string) => void
  selection?: TextSelectionCoordinates
  diagnostics?: { monaco: MonacoLike; editor: EditorLike } | null
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

  useEffect(() => {
    const appeared = !hadProposal.current && proposal !== null
    hadProposal.current = proposal !== null
    if (appeared) smartReveal(layoutScopeKey, "proposal-review", "wide")
  }, [layoutScopeKey, proposal, smartReveal])

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
          <div className="h-full overflow-auto">
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
        id: "problems",
        activity: "inspect",
        labelKey: "projectEditor.workbench.problems",
        icon: FileSearchIcon,
        order: 32,
        appliesTo: (resource) => resource.kind === "project-file",
        retention: "stateful",
        renderer: () =>
          diagnostics ? (
            <MonacoDiagnosticsBar
              monaco={diagnostics.monaco}
              editor={diagnostics.editor}
              className="h-full"
            />
          ) : (
            <div className="flex h-full items-center justify-center p-6 text-xs text-muted-foreground">
              {t("problemsUnavailable")}
            </div>
          ),
      },
      {
        id: "git-review",
        activity: "review",
        labelKey: "projectEditor.workbench.review",
        icon: GitCompareIcon,
        order: 35,
        appliesTo: (resource) => resource.kind === "project-file",
        retention: "stateful",
        preferredMode: "wide",
        renderer: () => <ProjectGitReviewPanel rootPath={rootPath} relPath={file.relPath} />,
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
      {
        id: "preview",
        activity: "preview-run",
        labelKey: "projectEditor.workbench.previewRun",
        icon: EyeIcon,
        order: 50,
        appliesTo: (resource) => resource.kind === "project-file",
        retention: "stateful",
        preferredMode: "wide",
        renderer: () => (
          <ProjectFilePreviewPanel relPath={file.relPath} content={file.draftContent ?? ""} />
        ),
      },
    ],
    [
      dirty,
      diagnostics,
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
      manageOwnWidth
      className="shrink-0"
    />
  )
}
