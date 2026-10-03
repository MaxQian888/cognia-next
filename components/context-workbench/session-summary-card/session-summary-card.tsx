"use client"

import { useMemo, type ReactNode } from "react"
import { useTranslations } from "next-intl"
import {
  BoxIcon,
  FileDiffIcon,
  FolderIcon,
  GitBranchIcon,
  HandIcon,
  LayoutGridIcon,
  LockIcon,
  PlusIcon,
  SearchIcon,
  Settings2Icon,
  UsersIcon,
  type LucideIcon,
} from "lucide-react"
import type { ChatSession } from "@cognia/agent-config-types"

import { getArtifactTypeIcon } from "@/components/artifacts/artifact-icons"
import { RoomParticipantsChip } from "@/components/chat/room-participants-chip"
import { SharedSessionPanel } from "@/components/chat/shared-session-panel"
import { Button } from "@/components/ui/button"
import { useSessionNeedsYou } from "@/hooks/chat/use-session-needs-you"
import { useSessionResourceChanges } from "@/hooks/chat/use-session-resource-changes"
import { useSessionRunProgress } from "@/hooks/chat/use-session-run-progress"
import { useSharedChatEnabled } from "@/hooks/collab/use-shared-chat-enabled"
import { revealArtifactInWorkspace, revealSessionPanel } from "@/lib/artifacts/reveal"
import { SESSION_ARTIFACT_LIST_PANEL_ID } from "@/lib/artifacts/session-workbench-scope-key"
import { jumpToSessionMessage } from "@/lib/chat/cross-session-jump"
import { collectSessionSources, groupSessionSourcesByLabel } from "@/lib/chat/session-sources"
import { cn } from "@/lib/utils"
import { resolveSessionExecutionRoot } from "@/lib/workspace/session-root"
import { useArtifactStore } from "@/stores/artifact/artifact-store"
import { useSessionMessages, useSessionStatus } from "@/stores/chat"
import { useGitStore } from "@/stores/git/git-store"
import { useProjectStore } from "@/stores/project/project-store"
import { isSummaryCardRowShown } from "@/types/shell/session-summary-card"
import type { Artifact } from "@/types"

import { useSessionSummaryCardPrefs } from "@/components/shell/use-session-summary-card-prefs"
import { SessionSummaryCardMenu } from "./session-summary-card-menu"

/** How many source groups the card lists before deferring to the panel. */
export const SUMMARY_CARD_SOURCE_LIMIT = 3
/** How many artifact icons the stack shows. */
const ARTIFACT_STACK_LIMIT = 3

export interface SessionSummaryCardProps {
  session: ChatSession
  /** Rendered width; the trigger clamps it to the chat stage. */
  width: number
  /** The card's presentation: floating beside the chat, or a popover. */
  mode: "float" | "popover"
  /** Tallest the card may grow before its body scrolls. */
  maxHeight?: number | string
  /** Called after a row hands the user somewhere else (closes a popover). */
  onNavigated: () => void
  /** Open the session settings sheet. */
  onManage: () => void
  /** Open the session settings sheet at the capabilities ("power") section. */
  onManageSources: () => void
  /** Float mode only: put the card away for this conversation. */
  onHide?: () => void
}

/**
 * The Codex-style summary of one conversation: what it is doing, what it is
 * waiting on, what it changed and made, and what it drew on.
 *
 * Every row is a way into the dock, which keeps the detail; the card itself
 * holds no state beyond the per-row visibility the user chose. It never opens
 * or closes the dock column, so it can sit beside whatever the dock shows.
 */
export function SessionSummaryCard({
  session,
  width,
  mode,
  maxHeight,
  onNavigated,
  onManage,
  onManageSources,
  onHide,
}: SessionSummaryCardProps) {
  const t = useTranslations("contextWorkbench.summaryCard")
  const tSources = useTranslations("contextWorkbench.sessionSources")
  const { rows } = useSessionSummaryCardPrefs()
  const status = useSessionStatus(session.id)
  const progress = useSessionRunProgress(session.id)
  const needsYou = useSessionNeedsYou(session.id)
  const changes = useSessionResourceChanges(session.id)
  const sharedChatEnabled = useSharedChatEnabled()
  const messages = useSessionMessages(session.id)
  const allArtifacts = useArtifactStore((state) => state.artifacts)
  const artifacts = useMemo(
    () =>
      Object.values(allArtifacts)
        .filter((artifact) => artifact.sessionId === session.id)
        .sort((a, b) => toTime(b.updatedAt) - toTime(a.updatedAt)),
    [allArtifacts, session.id]
  )
  const sourceGroups = useMemo(
    () =>
      groupSessionSourcesByLabel(
        collectSessionSources(messages, {
          document: tSources("labels.document"),
          file: tSources("labels.file"),
        })
      ),
    [messages, tSources]
  )

  const navigate = (panelId: string) => {
    revealSessionPanel(session.id, panelId)
    onNavigated()
  }
  const openArtifacts = () => {
    if (artifacts.length === 1) {
      revealArtifactInWorkspace(artifacts[0].id)
      onNavigated()
    } else navigate(SESSION_ARTIFACT_LIST_PANEL_ID)
  }
  const jumpToWaiting = () => {
    if (needsYou.jumpMessageId) void jumpToSessionMessage(session.id, needsYou.jumpMessageId)
    onNavigated()
  }

  const running = status === "streaming"
  const showProgress = isSummaryCardRowShown(
    rows.progress,
    progress.total > 0 && progress.current !== null
  )
  const showNeedsYou = isSummaryCardRowShown(rows.needsYou, needsYou.items.length > 0)
  const showChanges = isSummaryCardRowShown(rows.changes, changes.totals.files > 0)
  const showArtifacts = isSummaryCardRowShown(rows.artifacts, artifacts.length > 0)
  const showSources = isSummaryCardRowShown(rows.sources, sourceGroups.length > 0)
  const showSharing = isSummaryCardRowShown(
    rows.sharing,
    sharedChatEnabled || Boolean(session.collaboration)
  )

  return (
    <section
      aria-label={t("card", { title: session.title || session.id })}
      data-testid="session-summary-card"
      data-mode={mode}
      style={{ width, maxHeight }}
      className="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-border/70 bg-popover p-1.5 text-popover-foreground shadow-(--elevation-3)"
    >
      <CardHeader
        session={session}
        mode={mode}
        onManage={onManage}
        onManageSources={onManageSources}
        onHide={onHide}
      />

      <div className="min-h-0 overflow-y-auto">
        {showProgress && progress.total > 0 ? (
          <Row
            onClick={() => navigate("run-context")}
            className="h-auto flex-col items-stretch gap-1.5 py-2"
            testId="summary-row-progress"
          >
            <span className="flex min-w-0 items-center gap-2">
              <span
                className={cn(
                  "relative size-2 shrink-0 rounded-full",
                  running ? "bg-info" : "bg-muted-foreground/60"
                )}
                aria-hidden
              >
                {running ? (
                  <span className="absolute -inset-1 animate-ping rounded-full border border-info/70 motion-reduce:hidden" />
                ) : null}
              </span>
              <span className="min-w-0 flex-1 truncate text-left">
                {progress.current
                  ? t("progressCurrent", {
                      done: progress.done,
                      total: progress.total,
                      step: progress.current.activeForm ?? progress.current.content,
                    })
                  : t("progressDone", { total: progress.total })}
              </span>
              <span className="shrink-0 font-mono text-[11px] tabular-nums text-muted-foreground">
                {progress.done}/{progress.total}
              </span>
            </span>
            <span className="flex gap-0.5" aria-hidden>
              {progress.todos.map((todo, index) => (
                <span
                  key={index}
                  className={cn(
                    "h-[3px] flex-1 rounded-full",
                    todo.status === "completed"
                      ? "bg-foreground/80"
                      : todo.status === "in_progress"
                        ? "bg-info motion-safe:animate-pulse"
                        : "bg-border"
                  )}
                />
              ))}
            </span>
          </Row>
        ) : null}

        {showNeedsYou ? (
          <Row
            onClick={jumpToWaiting}
            icon={HandIcon}
            iconClassName="text-warning"
            tone={needsYou.items.length > 0 ? "warning" : undefined}
            testId="summary-row-needs-you"
            label={
              needsYou.items.length > 0
                ? t("needsYou", { count: needsYou.items.length })
                : t("rows.needsYou")
            }
            value={needsYou.items.length > 0 ? needsYou.items[0].label : t("changesNone")}
          />
        ) : null}

        {showChanges ? (
          <Row
            onClick={() => navigate("workspace")}
            icon={FileDiffIcon}
            testId="summary-row-changes"
            label={t("rows.changes")}
            value={<ChangesValue changes={changes} />}
          />
        ) : null}

        {showArtifacts ? (
          <Row
            onClick={openArtifacts}
            icon={BoxIcon}
            testId="summary-row-artifacts"
            label={t("rows.artifacts")}
            value={<ArtifactStack artifacts={artifacts} />}
            valueLabel={t("artifactCount", { count: artifacts.length })}
          />
        ) : null}

        {showSources ? (
          <div className="mt-1 border-t border-border/60 pt-1" data-testid="summary-sources">
            <div className="flex h-7 items-center justify-between px-2 text-xs text-muted-foreground">
              <span>{t("rows.sources")}</span>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-6 text-muted-foreground hover:text-foreground"
                aria-label={t("addSource")}
                title={t("addSource")}
                onClick={onManageSources}
              >
                <PlusIcon className="size-3.5" aria-hidden />
              </Button>
            </div>
            {sourceGroups.length === 0 ? (
              <p className="px-2 pb-1.5 text-xs text-muted-foreground">{t("sourcesNone")}</p>
            ) : (
              <>
                {sourceGroups.slice(0, SUMMARY_CARD_SOURCE_LIMIT).map((group) => (
                  <Row
                    key={group.label}
                    onClick={() => navigate("session-sources")}
                    icon={group.label === "tool" ? SearchIcon : LayoutGridIcon}
                    label={tSources(`labels.${group.label}`)}
                    value={
                      <span className="text-muted-foreground">
                        {t("sourceCount", { count: group.count })}
                      </span>
                    }
                  />
                ))}
                <Row
                  onClick={() => navigate("session-sources")}
                  icon={LayoutGridIcon}
                  label={<span className="text-muted-foreground">{t("viewAll")}</span>}
                  testId="summary-sources-view-all"
                />
              </>
            )}
          </div>
        ) : null}

        {showSharing ? <SharingRow session={session} /> : null}
      </div>
    </section>
  )
}

/**
 * Who the conversation is shared with, and the controls to share it. Not a
 * `Row`: the participants chip and the sharing panel's trigger are buttons of
 * their own, and a shared conversation's panel adds its connection status and
 * "Request AI" inline — the controls a shared room needs while it runs.
 */
function SharingRow({ session }: { session: ChatSession }) {
  const t = useTranslations("contextWorkbench.summaryCard")
  const tSharing = useTranslations("chatCollaboration")
  const shared = Boolean(session.collaboration)
  const Icon = shared ? UsersIcon : LockIcon
  return (
    <div
      className="mt-1 flex min-h-8 min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1 border-t border-border/60 px-2 pt-1 text-[13px]"
      data-testid="summary-row-sharing"
      aria-label={t("rows.sharing")}
      role="group"
    >
      <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span className="min-w-0 flex-1 truncate">{tSharing(shared ? "shared" : "private")}</span>
      <span className="flex shrink-0 items-center gap-1 text-xs">
        <RoomParticipantsChip session={session} />
        <SharedSessionPanel session={session} />
      </span>
    </div>
  )
}

function toTime(value: unknown): number {
  if (typeof value === "number") return value
  if (value instanceof Date) return value.getTime()
  if (typeof value === "string") return Date.parse(value) || 0
  return 0
}

function CardHeader({
  session,
  mode,
  onManage,
  onManageSources,
  onHide,
}: {
  session: ChatSession
  mode: "float" | "popover"
  onManage: () => void
  onManageSources: () => void
  onHide?: () => void
}) {
  const t = useTranslations("contextWorkbench.summaryCard")
  const tOverview = useTranslations("contextWorkbench.taskOverview")
  const projects = useProjectStore((state) => state.projects)
  const target = resolveSessionExecutionRoot(session, projects)
  const gitRoot = useGitStore((state) => state.rootDir)
  const gitBranch = useGitStore((state) => state.status?.branch ?? null)
  // The managed worktree names its branch; otherwise only a git panel bound to
  // this very root can say which branch is checked out.
  const branch =
    session.executionContext?.branch ?? (target.root && gitRoot === target.root ? gitBranch : null)
  return (
    <div className="flex h-8 min-w-0 items-center gap-1.5 px-2 text-xs text-muted-foreground">
      <FolderIcon className="size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 shrink truncate">
        {projects.find((project) => project.id === target.project?.id)?.name ?? t("noWorkspace")}
      </span>
      {branch ? (
        <span
          className="flex min-w-0 shrink items-center gap-1 truncate rounded-md bg-muted px-1.5 font-mono text-[11px]"
          title={t("branch", { branch })}
        >
          <GitBranchIcon className="size-3 shrink-0" aria-hidden />
          <span className="truncate">{branch}</span>
        </span>
      ) : null}
      <span className="flex-1" />
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-6 shrink-0 text-muted-foreground hover:text-foreground"
        aria-label={tOverview("manage")}
        title={tOverview("manage")}
        onClick={onManage}
      >
        <Settings2Icon className="size-3.5" aria-hidden />
      </Button>
      <SessionSummaryCardMenu
        sessionId={session.id}
        mode={mode}
        onManageSources={onManageSources}
        onHide={onHide}
      />
    </div>
  )
}

function Row({
  onClick,
  icon: Icon,
  iconClassName,
  label,
  value,
  valueLabel,
  tone,
  className,
  testId,
  children,
}: {
  onClick: () => void
  icon?: LucideIcon
  iconClassName?: string
  label?: ReactNode
  value?: ReactNode
  /** Accessible text for a value that is drawn rather than written. */
  valueLabel?: string
  tone?: "warning"
  className?: string
  testId?: string
  children?: ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      className={cn(
        "flex h-8 w-full min-w-0 items-center gap-2.5 rounded-lg px-2 text-left text-[13px] transition-colors",
        "hover:bg-accent focus-visible:bg-accent focus-visible:outline-none",
        tone === "warning" && "bg-warning/10 hover:bg-warning/15 focus-visible:bg-warning/15",
        className
      )}
    >
      {children ?? (
        <>
          {Icon ? (
            <Icon
              className={cn("size-4 shrink-0 text-muted-foreground", iconClassName)}
              aria-hidden
            />
          ) : null}
          <span className="min-w-0 flex-1 truncate">{label}</span>
          {value !== undefined ? (
            <span className="flex min-w-0 max-w-[55%] shrink-0 items-center justify-end gap-1 truncate text-xs">
              {valueLabel ? (
                <>
                  <span aria-hidden>{value}</span>
                  <span className="sr-only">{valueLabel}</span>
                </>
              ) : (
                value
              )}
            </span>
          ) : null}
        </>
      )}
    </button>
  )
}

function ChangesValue({ changes }: { changes: ReturnType<typeof useSessionResourceChanges> }) {
  const t = useTranslations("contextWorkbench.summaryCard")
  const { totals } = changes
  if (!changes.available) {
    return <span className="text-muted-foreground">{t("changesUnavailable")}</span>
  }
  if (totals.files === 0) return <span className="text-muted-foreground">{t("changesNone")}</span>
  if (!totals.linesKnown) {
    return (
      <span className="text-muted-foreground" title={t("linesUnknown")}>
        {t("changesFiles", { count: totals.files })}
      </span>
    )
  }
  return (
    <span className="flex items-center gap-1.5 font-mono tabular-nums">
      <span className="text-success" aria-hidden>
        +{totals.insertions.toLocaleString()}
      </span>
      <span className="text-destructive" aria-hidden>
        −{totals.deletions.toLocaleString()}
      </span>
      <span className="sr-only">
        {t("linesAdded", { count: totals.insertions })},{" "}
        {t("linesRemoved", { count: totals.deletions })}
      </span>
    </span>
  )
}

function ArtifactStack({ artifacts }: { artifacts: readonly Artifact[] }) {
  if (artifacts.length === 0) return <span className="text-muted-foreground">0</span>
  return (
    <span className="flex items-center gap-1.5">
      <span className="flex" aria-hidden>
        {artifacts.slice(0, ARTIFACT_STACK_LIMIT).map((artifact) => (
          <span
            key={artifact.id}
            className="-ml-1 flex size-5 items-center justify-center rounded-md bg-muted text-muted-foreground ring-2 ring-popover first:ml-0"
          >
            {getArtifactTypeIcon(artifact.type, "size-3")}
          </span>
        ))}
      </span>
      <span className="tabular-nums text-muted-foreground">{artifacts.length}</span>
    </span>
  )
}
