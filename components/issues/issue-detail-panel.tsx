"use client"

/**
 * Right-hand properties inspector for the selected issue.
 *
 * Renders whatever the board hands it, including federated rows — which is why
 * every mutating affordance is gated on `item.capabilities`. A GitHub mirror
 * row shows its properties read-only rather than offering controls that would
 * fail on write.
 *
 * The activity trail is a live Dexie query on `issueEvents`, so a change made
 * anywhere (board drag, IM card button, agent run) shows up here without a
 * refresh. Comments are activity entries — see `lib/db/issue-events.ts`.
 */

import { useEffect, useMemo, useState } from "react"
import {
  CircleSlashIcon,
  ExternalLinkIcon,
  FileCodeIcon,
  MessageSquarePlusIcon,
  PlayIcon,
  Share2Icon,
  SquareIcon,
  TagIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { LabelChip } from "@/components/labels/label-chip"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { collectFileReferences } from "@/lib/issues/editor-links"
import { publishRunToCollab } from "@/lib/collab/publish"
import { Separator } from "@/components/ui/separator"
import { useClientLiveQuery } from "@/hooks/data"
import { parseGithubMirrorId } from "@/lib/db/github-issue-mirror"
import { activityValues } from "@/lib/issues/activity-values"
import { listIssueEvents } from "@/lib/db/issue-events"
import { listIssueRuns } from "@/lib/db/issue-runs"
import { getCollabWorkspace } from "@/lib/db/collab-workspace-mirror"
import { addIssueComment, setIssueAssignee } from "@/lib/db/issues"
import { actorKey } from "@/lib/issues/board-model"
import type { IssueBulkAction } from "@/lib/issues/bulk-actions"
import { buildIssueMenuSections, canDeleteIssue } from "@/lib/issues/menu-model"
import { cancelIssueRun } from "@/lib/issues/run/registry"
import {
  isActiveIssueRunStatus,
  type IssueActor,
  type IssueProject,
  type IssueRun,
} from "@/types/issues"
import { parseUnifiedIssueId } from "@/types/issues/unified"
import type { UnifiedIssueItem } from "@/types/issues/unified"
import type { LabelRow } from "@/types/labels"
import type { AssigneeOption } from "./assignee-picker"
import { AssigneePicker } from "./assignee-picker"
import { IssueCommentComposer } from "./issue-comment-composer"
import { useMenuEntryPresentation } from "./editors/menu-entry-presentation"
import { IssuePropertyMenu } from "./editors/issue-property-menu"
import { IssueTextEditor } from "./editors/issue-text-editor"
import { GithubWritebackDialog, type GithubWritebackKind } from "./github-writeback-dialog"
import { LinkGithubIssueDialog } from "./link-github-issue-dialog"
import { IssuePriorityIcon, IssueStatusIcon } from "./issue-glyphs"
import { RunIssueDialog } from "./run-issue-dialog"
import { MentionBacklinksPanel } from "@/components/chat/mention-backlinks-chip"
import { entityBacklinkTarget } from "@/lib/chat/mentions/backlinks"

export interface IssueDetailPanelProps {
  item: UnifiedIssueItem
  labelsById?: ReadonlyMap<string, LabelRow>
  projectNamesById?: ReadonlyMap<string, string>
  /** Local labels only — a GitHub projection is not applicable to a local row. */
  labels?: readonly LabelRow[]
  projects?: readonly IssueProject[]
  assigneeOptions?: readonly AssigneeOption[]
  /** A run is in flight, which locks the status menu. */
  running?: boolean
  /**
   * GitHub repos bound to this issue's container. Offering the link control
   * only when one exists keeps it from producing a ref the run adapter would
   * immediately refuse.
   */
  githubRepos?: readonly string[]
  /**
   * Applies one edit. Routed through the caller so the outcome is reported
   * once, in one place, rather than by every control that can write.
   */
  onAction?: (action: IssueBulkAction) => void
  onRequestDelete?: () => void
  onClose?: () => void
  /** Fired after a GitHub write lands, so the caller can refresh the mirror. */
  onWritebackCompleted?: () => void
}

export function IssueDetailPanel({
  item,
  labelsById,
  projectNamesById,
  labels: writableLabels = [],
  projects = [],
  assigneeOptions = [],
  running = false,
  githubRepos = [],
  onAction,
  onRequestDelete,
  onClose,
  onWritebackCompleted,
}: IssueDetailPanelProps) {
  const t = useTranslations("issues")
  const [writeback, setWriteback] = useState<GithubWritebackKind | null>(null)
  const [runOpen, setRunOpen] = useState(false)
  const [linkOpen, setLinkOpen] = useState(false)

  // Only local rows have an activity trail in our own table.
  const parsed = parseUnifiedIssueId(item.unifiedId)
  const localId = parsed?.kind === "local" ? parsed.sourceId : null
  const writesCollabComments = parsed?.kind === "collab" && Boolean(onAction)
  const events = useClientLiveQuery(
    () =>
      localId
        ? listIssueEvents({ issueId: localId, descending: true, limit: 50 })
        : Promise.resolve([]),
    [localId],
    []
  )
  // Runs are issue-side rows (`issueRuns`), so the same live query covers a
  // dispatch from the IM card or a settlement from the engine watcher.
  const runs = useClientLiveQuery(
    () => (localId ? listIssueRuns({ issueId: localId }) : Promise.resolve([])),
    [localId],
    [] as IssueRun[]
  )
  const activeRun = (runs ?? []).find((run) => isActiveIssueRunStatus(run.status))
  const localWorkspaceId = projects.find((project) => project.id === item.issueProjectId)?.projectId
  const collabWorkspace = useClientLiveQuery(
    () => (localWorkspaceId ? getCollabWorkspace(localWorkspaceId) : Promise.resolve(undefined)),
    [localWorkspaceId],
    undefined
  )

  async function handleAssign(actor: IssueActor | null) {
    if (!localId) return
    try {
      await setIssueAssignee(localId, actor, { kind: "human" })
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause))
    }
  }

  async function handleCancelRun(runId: string) {
    try {
      await cancelIssueRun(runId)
      toast.success(t("run.cancelled"))
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause))
    }
  }

  const labels = item.labelIds
    .map((id) => labelsById?.get(id))
    .filter((label): label is LabelRow => Boolean(label))

  /**
   * The same sections the right-click menu renders, from the same model — so
   * an action offered here and refused there (or vice versa) is impossible.
   */
  const sections = useMemo(
    () =>
      buildIssueMenuSections({
        item,
        running,
        labels: writableLabels,
        projects,
        assigneeOptions,
      }),
    [item, running, writableLabels, projects, assigneeOptions]
  )
  const presentation = useMenuEntryPresentation({
    labels: writableLabels,
    projects,
    assigneeOptions,
  })
  const sectionsById = useMemo(
    () => new Map(sections.map((section) => [section.id, section])),
    [sections]
  )
  /** Every entry refused means the property is read-only for this row. */
  const allRefused = (id: Parameters<typeof sectionsById.get>[0]) => {
    const section = sectionsById.get(id)
    return !section || section.entries.every((entry) => entry.disabled)
  }

  /** Every file path mentioned in the title or body, not just the first. */
  const fileReferences = useMemo(
    () => collectFileReferences(item.title, item.description ?? ""),
    [item.title, item.description]
  )

  async function handleComment(body: string) {
    try {
      if (localId) {
        await addIssueComment(localId, body, { kind: "human" })
      } else if (writesCollabComments) {
        await onAction?.({ kind: "comment", body })
      }
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause))
    }
  }

  // Derived, never stored: a GitHub row's mirror id IS `owner/repo#n`, so the
  // write-back target cannot drift from the row it is shown next to.
  const githubTarget = parsed?.kind === "github" ? parseGithubMirrorId(parsed.sourceId) : null

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="issue-detail-panel">
      <header className="flex items-center gap-2 border-b px-4 py-3">
        <IssueStatusIcon status={item.status} />
        <span className="font-mono text-xs text-muted-foreground">{item.identifier}</span>
        <span className="flex-1" />
        {onClose ? (
          <Button
            size="icon"
            variant="ghost"
            className="size-7"
            aria-label={t("detail.close")}
            onClick={onClose}
            data-testid="issue-detail-close"
          >
            <XIcon className="size-4" />
          </Button>
        ) : null}
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4">
        <IssueTextEditor
          value={item.title}
          onCommit={(title) => onAction?.({ kind: "title", to: title })}
          disabled={!onAction || !item.capabilities.canEdit}
          required
          ariaLabel={t("detail.title")}
          testId="issue-detail-title"
          className="-mx-2 text-base font-semibold leading-snug"
        />

        {!item.capabilities.canEdit ? (
          <p
            className="rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground"
            data-testid="issue-detail-read-only"
          >
            {t("source.readOnly", { source: t(`source.${item.kind}`) })}
          </p>
        ) : null}

        <section className="flex flex-col gap-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            {t("detail.properties")}
          </h3>
          <PropertyRow label={t("detail.status")}>
            {sectionsById.get("status") && onAction ? (
              <IssuePropertyMenu
                section={sectionsById.get("status")!}
                presentation={presentation}
                onAction={onAction}
                disabled={allRefused("status")}
                testId="issue-detail-status"
              >
                <IssueStatusIcon status={item.status} />
                {t(`status.${item.status}`)}
              </IssuePropertyMenu>
            ) : (
              <span className="inline-flex items-center gap-1.5">
                <IssueStatusIcon status={item.status} />
                {t(`status.${item.status}`)}
              </span>
            )}
          </PropertyRow>
          <PropertyRow label={t("detail.priority")}>
            {sectionsById.get("priority") && onAction ? (
              <IssuePropertyMenu
                section={sectionsById.get("priority")!}
                presentation={presentation}
                onAction={onAction}
                disabled={allRefused("priority")}
                testId="issue-detail-priority"
              >
                <IssuePriorityIcon priority={item.priority} />
                {t(`priority.${item.priority}`)}
              </IssuePropertyMenu>
            ) : (
              <span className="inline-flex items-center gap-1.5">
                <IssuePriorityIcon priority={item.priority} />
                {t(`priority.${item.priority}`)}
              </span>
            )}
          </PropertyRow>
          <PropertyRow label={t("detail.assignee")}>
            {localId && item.capabilities.canAssign ? (
              <AssigneePicker
                value={item.assignee ?? null}
                onChange={handleAssign}
                data-testid="issue-detail-assignee-picker"
              />
            ) : (
              <span
                className={!item.assignee ? "italic opacity-70" : undefined}
                data-testid={`issue-detail-assignee-${actorKey(item.assignee) ?? "none"}`}
              >
                {item.assignee
                  ? (item.assignee.label ?? t(`actor.${item.assignee.kind}`))
                  : t("actor.unassigned")}
              </span>
            )}
          </PropertyRow>
          {sectionsById.get("project") && onAction ? (
            <PropertyRow label={t("detail.project")}>
              <IssuePropertyMenu
                section={sectionsById.get("project")!}
                presentation={presentation}
                onAction={onAction}
                disabled={allRefused("project")}
                testId="issue-detail-project"
              >
                <span className="truncate">
                  {item.issueProjectId
                    ? (projectNamesById?.get(item.issueProjectId) ?? item.issueProjectId)
                    : t("detail.empty")}
                </span>
              </IssuePropertyMenu>
            </PropertyRow>
          ) : item.issueProjectId ? (
            <PropertyRow label={t("detail.project")}>
              {projectNamesById?.get(item.issueProjectId) ?? item.issueProjectId}
            </PropertyRow>
          ) : null}
          <PropertyRow label={t("detail.labels")}>
            <span className="flex min-w-0 flex-wrap items-center gap-1">
              {labels.length === 0 ? (
                <span className="italic opacity-70">{t("labels.none")}</span>
              ) : (
                labels.map((label) => (
                  <LabelChip key={label.id} label={label} className="h-5 text-[10px]" />
                ))
              )}
              {sectionsById.get("labels") && onAction ? (
                <IssuePropertyMenu
                  section={sectionsById.get("labels")!}
                  presentation={presentation}
                  onAction={onAction}
                  disabled={allRefused("labels")}
                  testId="issue-detail-labels"
                >
                  <TagIcon className="size-3.5" />
                  {t("detail.editLabels")}
                </IssuePropertyMenu>
              ) : null}
            </span>
          </PropertyRow>
        </section>

        {item.description || onAction ? (
          <>
            <Separator />
            <section className="flex flex-col gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t("detail.description")}
              </h3>
              <IssueTextEditor
                value={item.description ?? ""}
                multiline
                onCommit={(description) => onAction?.({ kind: "description", to: description })}
                disabled={!onAction || !item.capabilities.canEdit}
                placeholder={t("detail.descriptionPlaceholder")}
                ariaLabel={t("detail.description")}
                testId="issue-detail-description"
                className="-mx-2 leading-relaxed"
              />
            </section>
          </>
        ) : null}

        {/* Which conversations have cited this issue with `@issue:`. Self-hides
            when none have. */}
        {localId ? <MentionBacklinksPanel target={entityBacklinkTarget("issue", localId)} /> : null}

        {/*
          A local issue with no `githubRef` cannot be run by the GitHub loop —
          the adapter refuses with `no-github-ref` — and nothing else in the app
          could ever set one.
        */}
        {localId && !item.origin.sourceLabel && githubRepos.length > 0 ? (
          <Button
            variant="outline"
            size="sm"
            className="h-7 w-fit gap-1.5 text-xs"
            onClick={() => setLinkOpen(true)}
            data-testid="issue-detail-link-github"
          >
            <ExternalLinkIcon className="size-3.5" />
            {t("writeback.linkTrigger")}
          </Button>
        ) : null}

        <OpenInProIde item={item} references={fileReferences} />

        {item.kind !== "local" ? (
          <a
            href={item.origin.deepLinkHref}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-1.5 text-xs text-primary underline-offset-4 hover:underline"
            data-testid="issue-detail-external-link"
          >
            <ExternalLinkIcon className="size-3.5" />
            {t("detail.openInGithub")}
          </a>
        ) : null}

        {githubTarget ? (
          <>
            <Separator />
            <section className="flex flex-col gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t("writeback.section")}
              </h3>
              {/*
                Labelled as GitHub writes, NOT as board controls. Dragging this
                card is still refused — the board position is derived from
                GitHub state, so the only honest way to change it is to change
                it upstream and let the next sync bring it back.
              */}
              <p className="text-xs text-muted-foreground">{t("writeback.sectionHint")}</p>
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={!item.capabilities.canComment}
                  onClick={() => setWriteback("comment")}
                  data-testid="issue-writeback-comment"
                >
                  <MessageSquarePlusIcon className="size-3.5" />
                  {t("writeback.title.comment")}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setWriteback("label")}
                  data-testid="issue-writeback-label"
                >
                  <TagIcon className="size-3.5" />
                  {t("writeback.title.label")}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={item.statusCategory === "completed"}
                  onClick={() => setWriteback("close")}
                  data-testid="issue-writeback-close"
                >
                  <CircleSlashIcon className="size-3.5" />
                  {t("writeback.title.close")}
                </Button>
              </div>
            </section>

            {writeback ? (
              <GithubWritebackDialog
                open
                onOpenChange={(next) => {
                  if (!next) setWriteback(null)
                }}
                kind={writeback}
                target={githubTarget}
                onCompleted={onWritebackCompleted}
              />
            ) : null}
          </>
        ) : null}

        {localId && item.capabilities.canRun ? (
          <>
            <Separator />
            <section className="flex flex-col gap-2" data-testid="issue-detail-runs">
              <div className="flex items-center gap-2">
                <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                  {t("run.section")}
                </h3>
                <span className="flex-1" />
                {activeRun ? (
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => handleCancelRun(activeRun.id)}
                    data-testid="issue-run-cancel"
                  >
                    <SquareIcon className="size-3.5" />
                    {t("run.cancel")}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={
                      item.statusCategory === "completed" || item.statusCategory === "canceled"
                    }
                    onClick={() => setRunOpen(true)}
                    data-testid="issue-run-trigger"
                  >
                    <PlayIcon className="size-3.5" />
                    {t("run.trigger")}
                  </Button>
                )}
              </div>
              {/*
                The runtime owns `in_progress` while a run is active; the human
                gets the issue back at `in_review`. Saying so here is what makes
                the greyed-out drag on the board explicable.
              */}
              <p className="text-xs text-muted-foreground">
                {activeRun ? t("run.activeHint") : t("run.sectionHint")}
              </p>
              {(runs ?? []).length > 0 ? (
                <ol className="flex flex-col gap-2" data-testid="issue-run-list">
                  {(runs ?? []).map((run) => (
                    <li
                      key={run.id}
                      className="flex flex-col gap-1 rounded-md border px-2 py-1.5 text-xs"
                      data-testid={`issue-run-${run.status}`}
                    >
                      <span className="flex items-center gap-2">
                        <Badge
                          variant={run.status === "failed" ? "destructive" : "secondary"}
                          className="h-4 px-1 text-[10px]"
                        >
                          {t(`run.status.${run.status}`)}
                        </Badge>
                        <span className="text-muted-foreground">
                          {t(`run.adapter.${run.adapterId}.name`)}
                        </span>
                        {collabWorkspace ? (
                          <Button
                            type="button"
                            size="sm"
                            variant="ghost"
                            className="ml-auto h-6 px-1.5 text-[10px]"
                            data-testid={`issue-run-share-${run.id}`}
                            onClick={() => {
                              void publishRunToCollab(run, `${item.identifier}: ${item.title}`, {
                                orgId: collabWorkspace.orgId,
                                workspaceId: collabWorkspace.id,
                              })
                                .then(() => toast.success(t("run.shared")))
                                .catch((cause) =>
                                  toast.error(
                                    cause instanceof Error ? cause.message : String(cause)
                                  )
                                )
                            }}
                          >
                            <Share2Icon className="size-3" />
                            {t("run.share")}
                          </Button>
                        ) : null}
                      </span>
                      {run.summary ? <p className="line-clamp-3">{run.summary}</p> : null}
                      {run.error ? <p className="text-destructive">{run.error}</p> : null}
                      {run.artifacts.length > 0 ? (
                        <span className="flex flex-wrap gap-2">
                          {run.artifacts.map((artifact) => (
                            <a
                              key={artifact.href}
                              href={artifact.href}
                              target={artifact.href.startsWith("/") ? undefined : "_blank"}
                              rel="noreferrer noopener"
                              className="inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline"
                              data-testid="issue-run-artifact"
                            >
                              <ExternalLinkIcon className="size-3" />
                              {artifact.label}
                            </a>
                          ))}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ol>
              ) : null}
            </section>
            {runOpen ? (
              <RunIssueDialog
                open
                onOpenChange={(next) => {
                  if (!next) setRunOpen(false)
                }}
                issueId={localId}
                identifier={item.identifier}
              />
            ) : null}
            {linkOpen ? (
              <LinkGithubIssueDialog
                open
                onOpenChange={(next) => {
                  if (!next) setLinkOpen(false)
                }}
                issueId={localId}
                repos={githubRepos}
                onLinked={onWritebackCompleted}
              />
            ) : null}
          </>
        ) : null}

        {localId || writesCollabComments ? (
          <>
            <Separator />
            <section className="flex flex-col gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t("detail.activity")}
              </h3>
              <ol className="flex flex-col gap-2" data-testid="issue-detail-activity">
                {(events ?? []).map((event) => (
                  <li key={event.id} className="flex flex-col gap-0.5 text-xs">
                    <span className="text-muted-foreground">
                      {event.kind === "commented" ? (
                        <Badge variant="secondary" className="mr-1 h-4 px-1 text-[10px]">
                          {t("detail.comment")}
                        </Badge>
                      ) : null}
                      {t(`activity.${event.kind}`, activityValues(event.payload, t))}
                    </span>
                    {event.payload.kind === "commented" ? (
                      <p className="whitespace-pre-wrap rounded-md bg-muted/40 px-2 py-1.5 text-sm">
                        {event.payload.body}
                      </p>
                    ) : null}
                  </li>
                ))}
              </ol>

              {/*
                The trail has always rendered comments; until now there was no
                way to write one, because `addIssueComment` had no caller.
              */}
              {item.capabilities.canComment ? (
                <IssueCommentComposer onSubmit={handleComment} />
              ) : null}
            </section>
          </>
        ) : null}

        {onRequestDelete && canDeleteIssue(item, running) ? (
          <>
            <Separator />
            <Button
              variant="ghost"
              size="sm"
              className="w-fit gap-1.5 text-destructive hover:text-destructive"
              onClick={onRequestDelete}
              data-testid="issue-detail-delete"
            >
              <Trash2Icon className="size-3.5" />
              {t("context.delete")}
            </Button>
          </>
        ) : null}
      </div>
    </div>
  )
}

function PropertyRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 text-sm">
      <span className="w-20 shrink-0 text-xs text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1">{children}</span>
    </div>
  )
}

/**
 * "Open in Pro IDE" — the shortest path from an issue to the code it is about.
 *
 * Rendered only when the issue actually names a linkable file (see
 * `lib/issues/editor-links`) AND a Pro IDE is bound, because an affordance that
 * is usually disabled teaches people to ignore it. Both checks are cheap and
 * synchronous, so this stays a plain render-time decision rather than an
 * effect.
 *
 * Deliberately NOT an `IssueRunAdapter`: a run owns `in_progress` and advances
 * the issue to `in_review` when it ends, and opening a file must not move an
 * issue's state at all.
 */
/**
 * Every file path mentioned in the issue, each openable in the Pro IDE.
 *
 * This used to open only `primaryFileReference` — the FIRST path found — so an
 * issue that named three files silently dropped two of them, and
 * `collectFileReferences` (written, tested, and the reason the scanner exists)
 * had no caller at all.
 */
function OpenInProIde({
  item,
  references,
}: {
  item: UnifiedIssueItem
  references: readonly { path: string; line?: number; column?: number }[]
}) {
  const t = useTranslations("issues")
  const [root, setRoot] = useState<string | null>(null)

  useEffect(() => {
    // Read after mount: the binding lives in a renderer module the server pass
    // never runs, and reading it during render would desync hydration.
    let cancelled = false
    void import("@/lib/codeserver/pane-manager").then(({ getActiveProIdeRoot }) => {
      if (!cancelled) setRoot(getActiveProIdeRoot())
    })
    return () => {
      cancelled = true
    }
  }, [item.unifiedId])

  if (references.length === 0 || !root) return null

  const open = async (reference: { path: string; line?: number; column?: number }) => {
    const { codeServerClient } = await import("@/lib/codeserver/client")
    const absolute =
      reference.path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(reference.path)
        ? reference.path
        : `${root.replace(/[/\\]+$/, "")}/${reference.path.replace(/^[./\\]+/, "")}`
    try {
      await codeServerClient.driveOpen(root, absolute, reference.line, reference.column)
    } catch {
      // The companion extension is not connected yet; the CLI opener still
      // gets the user to the file, just without the reveal fidelity.
      await codeServerClient.openFile(root, absolute, reference.line, reference.column)
    }
  }

  return (
    <div className="flex flex-wrap gap-1.5" data-testid="issue-detail-file-references">
      {references.map((reference) => (
        <Button
          key={`${reference.path}:${reference.line ?? ""}:${reference.column ?? ""}`}
          variant="outline"
          size="sm"
          className="h-7 w-fit gap-1.5 text-xs"
          onClick={() => void open(reference)}
          data-testid={`issue-detail-open-in-pro-ide-${reference.path}`}
        >
          <FileCodeIcon className="size-3.5" />
          {t("detail.openInProIde", { path: reference.path })}
        </Button>
      ))}
    </div>
  )
}
