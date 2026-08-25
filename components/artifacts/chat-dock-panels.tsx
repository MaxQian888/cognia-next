"use client"

/**
 * The chat dock's panel catalogue — every surface the right rail can show, for
 * both of its resource kinds.
 *
 * These definitions used to live inline in `artifact-dock.tsx`, interleaved with
 * that file's width-hint and reveal-intent plumbing. They are lifted out
 * verbatim for one reason: the dock kernel (ADR-0102) consumes a *list of panel
 * definitions*, so whichever engine renders the chat dock — today's
 * `ContextWorkbench`, tomorrow's `DockHost` — needs the same list from the same
 * place. Keeping them inline would mean maintaining two copies of nine panels
 * behind a feature flag.
 *
 * This module is deliberately pure catalogue: no layout, no persistence, no
 * engine. Each hook takes the facts a panel needs and returns the array, with
 * the identical `useMemo` dependencies the inline versions had.
 */

import {
  ActivityIcon,
  BotIcon,
  BrainIcon,
  GitBranchIcon,
  History,
  LibraryIcon,
  MessageSquareIcon,
  MessagesSquareIcon,
  PanelsTopLeftIcon,
  SearchCodeIcon,
  FileSearchIcon,
  FolderKanbanIcon,
  InfoIcon,
  GlobeIcon,
  CornerUpLeftIcon,
  ListChecksIcon,
  UsersIcon,
} from "lucide-react"
import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import type { UIMessage } from "ai"
import { Button } from "@/components/ui/button"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Textarea } from "@/components/ui/textarea"
import { buildAsideContext } from "@/lib/chat/session-aside-context"
import { SIDECHAT_PANEL_ID } from "@/lib/tasks/spawn-task-core"
import { useChatViewportStore } from "@/stores/chat/chat-viewport-store"
import { useContextWorkbenchStore } from "@/stores/context-workbench/context-workbench-store"
import { ResourceWorkbenchChatPanel } from "@/components/context-workbench/resource-workbench-chat-panel"
import { ContextMetadataPanel } from "@/components/context-workbench/context-metadata-panel"
import { ContextCommentsPanel } from "@/components/context-workbench/context-comments-panel"
import { ContextCapabilityUnavailable } from "@/components/context-workbench/context-capability-unavailable"
import { SessionSourcesPanel } from "@/components/context-workbench/session-sources-panel"
import { BrowserPreviewPane } from "@/components/browser/browser-preview-pane"
import { ArtifactPanelContent, type ArtifactPanelMode } from "./artifact-panel-content"
import { ArtifactList } from "./artifact-list"
import { SESSION_ARTIFACT_LIST_PANEL_ID } from "@/lib/artifacts/session-workbench-scope-key"
import { ArtifactReviewView } from "./artifact-review-view"
import { DockWorkspace } from "./workspace-mode/dock-workspace"
import { ProjectOverviewPanel } from "./workspace-mode/project-overview-panel"
import { MemoryWorkbenchPanel } from "@/components/context-workbench/panels/memory-workbench-panel"
import { SourceControlWorkbenchPanel } from "@/components/context-workbench/panels/source-control-workbench-panel"
import { LogsWorkbenchPanel } from "@/components/context-workbench/panels/logs-workbench-panel"
import {
  SQUAD_CONTEXT_PANEL_ID,
  SquadContextPanel,
} from "@/components/context-workbench/panels/squad-context-panel"
import {
  TEAM_MEMBERS_PANEL_ID,
  TeamMembersPanel,
} from "@/components/context-workbench/panels/team-members-panel"
import { RunContextPanel } from "@/components/context-workbench/panels/run-context-panel"
import type {
  ContextPanelDefinition,
  ContextPanelMode,
  TextSelectionCoordinates,
} from "@/types/context-workbench"
import type { Artifact, CanvasPendingReview } from "@/types/artifact/artifact"
import type { Project, Session } from "@/types/plugin/_compat"

/**
 * The two project surfaces need the wider sizing profile: the editor carries a
 * file tree + Monaco + Git diff, while the overview carries analysis and a
 * compact Source Control changes list.
 */
export const WORKSPACE_PANEL_ID = "workspace"
export const PROJECT_OVERVIEW_PANEL_ID = "project-overview"

/** How dense the panels should render — the host's decision, not the viewport's. */
type ChatDockWorkspaceLayout = "mobile" | "desktop"

export interface ArtifactSurfacePanelsInput {
  artifactId: string
  /** `undefined` once the id outlives its artifact; panels render nothing. */
  artifact: Artifact | undefined
  activeSessionId: string | null
  sessionProject: Project | undefined
  hostLayout: ArtifactPanelMode
  workspaceLayout: ChatDockWorkspaceLayout
  workspaceAvailable: boolean
  pendingReview: CanvasPendingReview | null
  unresolvedCommentCount: number
  /** Session-level proposals remain visible while an artifact is active. */
  pendingRunLearningCount?: number
  textSelection: TextSelectionCoordinates | undefined
  pendingSelectionComment: string | null
  onPendingSelectionComment: (comment: string | null) => void
  /** This surface's workbench scope, for the overview panel's hand-off. */
  scopeKey: string
  onWidthHint: (mode: ContextPanelMode, panelId?: string) => void
}

/** The dock's artifact-surface panel catalogue. */
export function useArtifactSurfacePanels({
  artifactId,
  artifact,
  activeSessionId,
  sessionProject,
  hostLayout,
  workspaceLayout,
  workspaceAvailable,
  pendingReview,
  unresolvedCommentCount,
  pendingRunLearningCount = 0,
  textSelection,
  pendingSelectionComment,
  onPendingSelectionComment,
  scopeKey,
  onWidthHint,
}: ArtifactSurfacePanelsInput): ContextPanelDefinition[] {
  const tWorkbench = useTranslations("contextWorkbench")

  return useMemo<ContextPanelDefinition[]>(
    () => [
      {
        id: "resource-chat",
        activity: "ai",
        labelKey: "contextWorkbench.resourceChat",
        icon: BotIcon,
        order: 25,
        appliesTo: (resource) => resource.kind === "artifact",
        retention: "stateful",
        requiresChatScope: true,
        renderer: () => (
          <ResourceWorkbenchChatPanel
            getResourceContext={() => artifact?.content ?? ""}
            pendingPrompt={pendingSelectionComment}
            onPendingPromptConsumed={() => onPendingSelectionComment(null)}
            // The selection composer used to be a panel of its own
            // (`selection-ai`), sharing the `ai` activity with this one at a
            // higher `order` — so the rail button could only ever open this
            // panel, and once two artifact tabs claimed the header the group
            // tabs collapsed into an overflow menu and buried it a second time.
            // Folding it in makes "select a range, hand it to the AI" one click
            // from the rail, next to the conversation it feeds.
            selectionHeader={
              <ArtifactSelectionCommentPanel
                hasSelection={Boolean(textSelection)}
                onSubmit={onPendingSelectionComment}
              />
            }
          />
        ),
      },
      {
        id: "comments",
        activity: "comments",
        labelKey: "contextWorkbench.comments",
        icon: MessageSquareIcon,
        order: 30,
        appliesTo: (resource) => resource.kind === "artifact",
        retention: "stateful",
        getBadge: () => unresolvedCommentCount,
        renderer: () =>
          artifact ? (
            <ContextCommentsPanel
              resource={{ kind: "artifact", id: artifactId, projectId: artifact.projectId }}
              resourceTitle={artifact.title}
              revision={String(artifact.version)}
              anchor={
                textSelection
                  ? {
                      kind: "text-range",
                      start: textSelection.start,
                      end: textSelection.end,
                      revision: String(artifact.version),
                    }
                  : undefined
              }
            />
          ) : null,
      },
      {
        // Ordered *after* the artifact list inside the `review` activity. The
        // rail's group button targets the lowest-ordered panel, so leading with
        // this one meant every first click on Review landed on a proposal that
        // usually does not exist, while the artifact library — the panel with
        // content every time — sat behind the overflow menu. A pending proposal
        // still comes forward on its own via `smartReveal` + the badge below.
        id: "proposal-review",
        activity: "review",
        labelKey: "contextWorkbench.proposalReview",
        icon: History,
        order: 20,
        appliesTo: (resource) => resource.kind === "artifact",
        retention: "stateful",
        preferredMode: "wide",
        getBadge: () => (pendingReview ? 1 : 0),
        renderer: () =>
          artifact ? <ArtifactReviewView artifact={artifact} panelMode={hostLayout} /> : null,
      },
      {
        id: "preview",
        activity: "preview-run",
        labelKey: "artifacts.dock.artifactMode",
        icon: PanelsTopLeftIcon,
        order: 10,
        appliesTo: (resource) => resource.kind === "artifact",
        retention: "stateful",
        renderer: () => <ArtifactPanelContent panelMode={hostLayout} />,
      },
      {
        // Session-scoped content on an artifact-scoped surface, deliberately:
        // grouped with the preview so reaching the browser costs one click and
        // never drops the artifact you were looking at.
        id: "browser",
        activity: "preview-run",
        labelKey: "browser.title",
        icon: GlobeIcon,
        order: 11,
        appliesTo: (resource) => resource.kind === "artifact",
        retention: "stateful",
        // Its content belongs to the conversation, not to this artifact, so it
        // survives a tab switch. Without this the page — and the process-wide
        // embedded-webview lease behind it — was torn down every time.
        scope: "session",
        preferredMode: "wide",
        renderer: () => (
          <BrowserPreviewPane
            sessionId={activeSessionId ?? undefined}
            // `retention: "stateful"` keeps this panel mounted behind whichever
            // tab is showing, so a ⌘-clicked link must bring it to the front
            // before it may claim the URL — otherwise the link reads as a no-op.
            onRequestReveal={() =>
              useContextWorkbenchStore.getState().smartReveal(scopeKey, "browser", "wide")
            }
          />
        ),
      },
      {
        // Named for what it shows — every artifact in scope — not "history".
        // It shared that word with `PanelVersionHistory`, which is the real
        // version history and lives in the preview panel's overflow menu, so
        // the rail promised one thing and delivered the other.
        id: SESSION_ARTIFACT_LIST_PANEL_ID,
        activity: "review",
        labelKey: "artifacts.dock.browseArtifacts",
        icon: LibraryIcon,
        order: 15,
        appliesTo: (resource) => resource.kind === "artifact",
        retention: "stateful",
        preferredMode: "wide",
        renderer: () => (
          <ArtifactList
            sessionId={activeSessionId ?? undefined}
            className="h-full"
            maxHeight="100%"
          />
        ),
      },
      {
        id: "run-context",
        activity: "inspect",
        labelKey: "contextWorkbench.runContext.title",
        icon: ListChecksIcon,
        order: 37,
        appliesTo: (resource) => resource.kind === "artifact",
        retention: "stateful",
        scope: "session",
        getBadge: () => pendingRunLearningCount,
        renderer: () => (activeSessionId ? <RunContextPanel sessionId={activeSessionId} /> : null),
      },
      {
        id: "metadata",
        activity: "inspect",
        labelKey: "contextWorkbench.metadata.artifactTitle",
        icon: InfoIcon,
        order: 35,
        appliesTo: (resource) => resource.kind === "artifact",
        retention: "stateful",
        renderer: () =>
          artifact ? (
            <ContextMetadataPanel
              title={tWorkbench("metadata.artifactTitle")}
              fields={[
                { label: tWorkbench("metadata.artifactType"), value: artifact.type },
                {
                  label: tWorkbench("metadata.language"),
                  value: artifact.language ?? tWorkbench("metadata.unknown"),
                },
                { label: tWorkbench("metadata.version"), value: artifact.version },
                {
                  label: tWorkbench("metadata.runtimeStatus"),
                  value: artifact.metadata?.runtimeHealth ?? tWorkbench("metadata.notRun"),
                },
                {
                  label: tWorkbench("metadata.updatedAt"),
                  value: artifact.updatedAt.toLocaleString(),
                },
              ]}
              footer={<ArtifactSourceMessageLink messageId={artifact.messageId} />}
            />
          ) : null,
      },
      {
        id: "memory",
        activity: "inspect",
        labelKey: "contextWorkbench.memoryPanel.title",
        icon: BrainIcon,
        order: 36,
        appliesTo: (resource) => resource.kind === "artifact",
        retention: "stateful",
        renderer: () => <MemoryWorkbenchPanel sessionId={activeSessionId} />,
      },
      {
        id: PROJECT_OVERVIEW_PANEL_ID,
        activity: "workspace",
        labelKey: "projectOverview.panelTitle",
        icon: FolderKanbanIcon,
        order: 25,
        appliesTo: (resource) =>
          resource.kind === "artifact" && Boolean(sessionProject?.roots.length),
        retention: "stateful",
        scope: "session",
        preferredMode: "wide",
        renderer: () =>
          sessionProject ? (
            <ProjectOverviewPanel
              projectId={sessionProject.id}
              onOpenWorkspace={() => {
                useContextWorkbenchStore
                  .getState()
                  .navigatePanel(scopeKey, WORKSPACE_PANEL_ID, "wide")
                onWidthHint("wide", WORKSPACE_PANEL_ID)
              }}
            />
          ) : null,
      },
      {
        id: WORKSPACE_PANEL_ID,
        activity: "workspace",
        labelKey: "artifacts.dock.workspaceMode",
        icon: SearchCodeIcon,
        order: 40,
        appliesTo: (resource) => resource.kind === "artifact",
        retention: "stateful",
        // Same as the browser: the file tree, the open Monaco buffers and the
        // git diff belong to the conversation's project, not to one artifact.
        scope: "session",
        preferredMode: "wide",
        renderer: () =>
          workspaceAvailable ? (
            <DockWorkspace activeSessionId={activeSessionId} layout={workspaceLayout} />
          ) : (
            <ContextCapabilityUnavailable capability="workspace" />
          ),
      },
    ],
    [
      activeSessionId,
      artifact,
      artifactId,
      onWidthHint,
      hostLayout,
      workspaceLayout,
      pendingReview,
      pendingRunLearningCount,
      pendingSelectionComment,
      onPendingSelectionComment,
      sessionProject,
      scopeKey,
      tWorkbench,
      textSelection,
      unresolvedCommentCount,
      workspaceAvailable,
    ]
  )
}

export interface SessionSurfacePanelsInput {
  activeSessionId: string | null
  session: Session | null
  sessionProject: Project | undefined
  sessionMessages: UIMessage[]
  messageCount: number
  workspaceLayout: ChatDockWorkspaceLayout
  workspaceAvailable: boolean
  unresolvedCommentCount: number
  /** Number of unique sources referenced in session messages. */
  sourceCount?: number
  /** Number of uncommitted file changes in the project workspace. */
  uncommittedChangeCount?: number
  /** Number of run-learning proposals awaiting an explicit user decision. */
  pendingRunLearningCount?: number
  scopeKey: string
  onWidthHint: (mode: ContextPanelMode, panelId?: string) => void
}

/** The eight panels of the dock's session surface — no artifact is active. */
export function useSessionSurfacePanels({
  activeSessionId,
  session,
  sessionProject,
  sessionMessages,
  messageCount,
  workspaceLayout,
  workspaceAvailable,
  unresolvedCommentCount,
  sourceCount = 0,
  uncommittedChangeCount = 0,
  pendingRunLearningCount = 0,
  scopeKey,
  onWidthHint,
}: SessionSurfacePanelsInput): ContextPanelDefinition[] {
  const tWorkbench = useTranslations("contextWorkbench")

  return useMemo<ContextPanelDefinition[]>(
    () => [
      {
        id: SESSION_ARTIFACT_LIST_PANEL_ID,
        activity: "review",
        labelKey: "artifacts.dock.browseArtifacts",
        icon: LibraryIcon,
        order: 10,
        appliesTo: (resource) => resource.kind === "session",
        retention: "stateful",
        renderer: () => (
          <ArtifactList
            sessionId={activeSessionId ?? undefined}
            className="h-full"
            maxHeight="100%"
          />
        ),
      },
      {
        // Sidechat belongs on the session surface: it is an aside to the main
        // conversation, not a property of whichever artifact happens to be
        // open. `useResourceWorkbenchSession` ensures the primary aside as soon
        // as this panel activates.
        id: SIDECHAT_PANEL_ID,
        activity: "ai",
        labelKey: "contextWorkbench.sessionSidechat",
        icon: MessagesSquareIcon,
        order: 15,
        appliesTo: (resource) =>
          resource.kind === "session" && !resource.sessionId.startsWith("resource-workbench:"),
        retention: "stateful",
        requiresChatScope: Boolean(activeSessionId),
        renderer: () =>
          activeSessionId ? (
            <ResourceWorkbenchChatPanel
              // Re-resolved on every send, so the aside always sees the main
              // thread as it stands now rather than a snapshot from when the
              // panel opened.
              getResourceContext={() => buildAsideContext(sessionMessages)}
              asideTargetSessionId={activeSessionId}
              multiAside
            />
          ) : (
            <Empty className="h-full rounded-none">
              <EmptyHeader>
                <EmptyMedia variant="icon">
                  <MessagesSquareIcon />
                </EmptyMedia>
                <EmptyTitle className="text-base">
                  {tWorkbench("sidechatPlaceholder.title")}
                </EmptyTitle>
                <EmptyDescription>{tWorkbench("sidechatPlaceholder.description")}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ),
      },
      {
        id: "browser",
        activity: "preview-run",
        labelKey: "browser.title",
        icon: GlobeIcon,
        order: 20,
        appliesTo: (resource) => resource.kind === "session",
        retention: "stateful",
        scope: "session",
        preferredMode: "wide",
        renderer: () => (
          <BrowserPreviewPane
            sessionId={activeSessionId ?? undefined}
            // `retention: "stateful"` keeps this panel mounted behind whichever
            // tab is showing, so a ⌘-clicked link must bring it to the front
            // before it may claim the URL — otherwise the link reads as a no-op.
            onRequestReveal={() =>
              useContextWorkbenchStore.getState().smartReveal(scopeKey, "browser", "wide")
            }
          />
        ),
      },
      {
        id: PROJECT_OVERVIEW_PANEL_ID,
        activity: "workspace",
        labelKey: "projectOverview.panelTitle",
        icon: FolderKanbanIcon,
        order: 25,
        appliesTo: (resource) =>
          resource.kind === "session" && Boolean(sessionProject?.roots.length),
        retention: "stateful",
        scope: "session",
        preferredMode: "wide",
        renderer: () =>
          sessionProject ? (
            <ProjectOverviewPanel
              projectId={sessionProject.id}
              onOpenWorkspace={() => {
                useContextWorkbenchStore
                  .getState()
                  .navigatePanel(scopeKey, WORKSPACE_PANEL_ID, "wide")
                onWidthHint("wide", WORKSPACE_PANEL_ID)
              }}
            />
          ) : null,
      },
      {
        id: WORKSPACE_PANEL_ID,
        activity: "workspace",
        labelKey: "artifacts.dock.workspaceMode",
        icon: SearchCodeIcon,
        order: 30,
        appliesTo: (resource) => resource.kind === "session",
        retention: "stateful",
        scope: "session",
        preferredMode: "wide",
        getBadge: () => uncommittedChangeCount,
        renderer: () =>
          workspaceAvailable ? (
            <DockWorkspace activeSessionId={activeSessionId} layout={workspaceLayout} />
          ) : (
            <ContextCapabilityUnavailable capability="workspace" />
          ),
      },
      {
        id: "source-control",
        activity: "workspace",
        labelKey: "contextWorkbench.sourceControlPanel.title",
        icon: GitBranchIcon,
        order: 35,
        appliesTo: (resource) => resource.kind === "session",
        retention: "stateful",
        scope: "session",
        getBadge: () => uncommittedChangeCount,
        renderer: () =>
          workspaceAvailable ? (
            <SourceControlWorkbenchPanel />
          ) : (
            <ContextCapabilityUnavailable capability="workspace" />
          ),
      },
      {
        // The conversation can be commented on like any other resource — notes
        // about a chat had nowhere to live, so they ended up as messages to the
        // assistant, which is a different thing entirely. `contextComments`
        // already accepts every `ContextResource` kind, `session` included.
        id: "comments",
        activity: "comments",
        labelKey: "contextWorkbench.comments",
        icon: MessageSquareIcon,
        order: 40,
        appliesTo: (resource) => resource.kind === "session",
        retention: "stateful",
        getBadge: () => unresolvedCommentCount,
        renderer: () =>
          activeSessionId ? (
            <ContextCommentsPanel
              resource={{ kind: "session", id: activeSessionId, projectId: session?.projectId }}
              resourceTitle={session?.title}
              revision={String(session?.updatedAt ?? 0)}
            />
          ) : null,
      },
      {
        id: "run-context",
        activity: "inspect",
        labelKey: "contextWorkbench.runContext.title",
        icon: ListChecksIcon,
        order: 44,
        appliesTo: (resource) => resource.kind === "session",
        retention: "stateful",
        scope: "session",
        getBadge: () => pendingRunLearningCount,
        renderer: () => (activeSessionId ? <RunContextPanel sessionId={activeSessionId} /> : null),
      },
      {
        id: "session-sources",
        activity: "inspect",
        labelKey: "contextWorkbench.sessionSources.title",
        icon: FileSearchIcon,
        order: 45,
        appliesTo: (resource) => resource.kind === "session",
        retention: "stateful",
        getBadge: () => sourceCount,
        renderer: () => <SessionSourcesPanel messages={sessionMessages} />,
      },
      {
        // Fills the `inspect` rail slot, which stood empty on this surface while
        // both sibling surfaces (artifact, project) offered one. Everything here
        // was previously reachable only by opening session settings.
        id: "metadata",
        activity: "inspect",
        labelKey: "contextWorkbench.metadata.sessionTitle",
        icon: InfoIcon,
        order: 50,
        appliesTo: (resource) => resource.kind === "session",
        retention: "stateful",
        renderer: () =>
          session ? (
            <ContextMetadataPanel
              title={tWorkbench("metadata.sessionTitle")}
              fields={[
                {
                  label: tWorkbench("metadata.model"),
                  value: session.model ?? tWorkbench("metadata.unknown"),
                },
                {
                  label: tWorkbench("metadata.provider"),
                  value: session.providerOverride ?? tWorkbench("metadata.unknown"),
                },
                {
                  label: tWorkbench("metadata.workingDir"),
                  value: session.workingDir ?? tWorkbench("metadata.unknown"),
                },
                { label: tWorkbench("metadata.messageCount"), value: messageCount },
                {
                  label: tWorkbench("metadata.createdAt"),
                  value: new Date(session.createdAt).toLocaleString(),
                },
                { label: tWorkbench("metadata.sessionId"), value: session.id },
              ]}
            />
          ) : null,
      },
      {
        id: "memory",
        activity: "inspect",
        labelKey: "contextWorkbench.memoryPanel.title",
        icon: BrainIcon,
        order: 55,
        appliesTo: (resource) => resource.kind === "session",
        retention: "stateful",
        renderer: () => <MemoryWorkbenchPanel sessionId={activeSessionId} />,
      },
      {
        id: "logs",
        activity: "inspect",
        labelKey: "contextWorkbench.logsPanel.title",
        icon: ActivityIcon,
        order: 60,
        appliesTo: (resource) => resource.kind === "session",
        retention: "stateful",
        renderer: () => <LogsWorkbenchPanel />,
      },
      {
        // The Squad running THIS conversation. Its predecessor showed
        // whichever Squad the old workspace page happened to have selected —
        // global state in a rail whose every other panel follows the resource
        // in front of you. Takes the same slot so a customised rail order
        // survives.
        id: SQUAD_CONTEXT_PANEL_ID,
        activity: "ai",
        labelKey: "contextWorkbench.squadPanel.title",
        icon: UsersIcon,
        order: 16,
        appliesTo: (resource) => resource.kind === "session",
        retention: "stateful",
        scope: "session",
        renderer: () => <SquadContextPanel sessionId={activeSessionId} />,
      },
      {
        // Team conversations only — the roster, the shared notes and the
        // per-member actions that used to be a third column of their own
        // (`components/shell/member-list.tsx`, removed). A direct chat has no
        // roster, so the panel does not claim a rail slot there at all.
        id: TEAM_MEMBERS_PANEL_ID,
        activity: "ai",
        labelKey: "contextWorkbench.teamMembersPanel.title",
        icon: UsersIcon,
        order: 17,
        appliesTo: (resource) => resource.kind === "session" && session?.kind === "team",
        retention: "stateful",
        scope: "session",
        renderer: () => (
          <TeamMembersPanel teamSessionId={activeSessionId} teamId={session?.teamId ?? null} />
        ),
      },
    ],
    [
      activeSessionId,
      onWidthHint,
      pendingRunLearningCount,
      messageCount,
      session,
      sessionMessages,
      sessionProject,
      scopeKey,
      sourceCount,
      tWorkbench,
      uncommittedChangeCount,
      unresolvedCommentCount,
      workspaceAvailable,
      workspaceLayout,
    ]
  )
}

/**
 * Jump the conversation to the message this artifact came out of.
 *
 * Every artifact has recorded its `messageId` since the beginning, but nothing
 * ever read it back: the chat could open the dock, and the dock could not point
 * at the chat. Renders nothing when no message list is mounted to jump within
 * (the artifact workspace route, a Sheet host with no conversation behind it).
 */
function ArtifactSourceMessageLink({ messageId }: { messageId: string }) {
  const t = useTranslations("contextWorkbench.metadata")
  const tJump = useTranslations("chat.jump")
  const jumpToMessage = useChatViewportStore((state) => state.jumpToMessage)
  if (!jumpToMessage) return null
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className="w-full"
      data-testid="artifact-source-message-link"
      // A mounted list is not a reachable message: the source can have been
      // compacted away or belong to another session. Say so instead of
      // swallowing the click.
      onClick={() => {
        if (!jumpToMessage(messageId, undefined, { align: "center" })) {
          toast.error(tJump("notFound"))
        }
      }}
    >
      <CornerUpLeftIcon className="size-4" />
      {t("goToSource")}
    </Button>
  )
}

function ArtifactSelectionCommentPanel({
  hasSelection,
  onSubmit,
}: {
  hasSelection: boolean
  onSubmit: (comment: string) => void
}) {
  const t = useTranslations("contextWorkbench.artifactSelectionComment")
  const [comment, setComment] = useState("")
  const canSubmit = hasSelection && comment.trim().length > 0

  return (
    <div className="space-y-3 p-3">
      <p className="text-xs text-muted-foreground">
        {hasSelection ? t("selectionReady") : t("selectFirst")}
      </p>
      <Textarea
        value={comment}
        onChange={(event) => setComment(event.target.value)}
        placeholder={t("placeholder")}
        aria-label={t("label")}
        rows={5}
      />
      <Button
        type="button"
        className="w-full"
        disabled={!canSubmit}
        onClick={() => {
          onSubmit(comment.trim())
          setComment("")
        }}
      >
        <BotIcon className="size-4" />
        {t("sendToAi")}
      </Button>
    </div>
  )
}
