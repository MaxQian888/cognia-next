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

import { useEffect, useState } from "react"
import {
  CircleSlashIcon,
  ExternalLinkIcon,
  FileCodeIcon,
  MessageSquarePlusIcon,
  PlayIcon,
  SquareIcon,
  TagIcon,
  XIcon,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"

import { LabelChip } from "@/components/labels/label-chip"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { primaryFileReference } from "@/lib/issues/editor-links"
import { Separator } from "@/components/ui/separator"
import { useClientLiveQuery } from "@/hooks/data"
import { parseGithubMirrorId } from "@/lib/db/github-issue-mirror"
import { listIssueEvents } from "@/lib/db/issue-events"
import { listIssueRuns } from "@/lib/db/issue-runs"
import { setIssueAssignee } from "@/lib/db/issues"
import { actorKey } from "@/lib/issues/board-model"
import { cancelIssueRun } from "@/lib/issues/run/registry"
import { isActiveIssueRunStatus, type IssueActor, type IssueRun } from "@/types/issues"
import { parseUnifiedIssueId } from "@/types/issues/unified"
import type { UnifiedIssueItem } from "@/types/issues/unified"
import type { LabelRow } from "@/types/labels"
import { AssigneePicker } from "./assignee-picker"
import { GithubWritebackDialog, type GithubWritebackKind } from "./github-writeback-dialog"
import { IssuePriorityIcon, IssueStatusIcon } from "./issue-glyphs"
import { RunIssueDialog } from "./run-issue-dialog"

export interface IssueDetailPanelProps {
  item: UnifiedIssueItem
  labelsById?: ReadonlyMap<string, LabelRow>
  projectNamesById?: ReadonlyMap<string, string>
  onClose?: () => void
  /** Fired after a GitHub write lands, so the caller can refresh the mirror. */
  onWritebackCompleted?: () => void
}

export function IssueDetailPanel({
  item,
  labelsById,
  projectNamesById,
  onClose,
  onWritebackCompleted,
}: IssueDetailPanelProps) {
  const t = useTranslations("issues")
  const [writeback, setWriteback] = useState<GithubWritebackKind | null>(null)
  const [runOpen, setRunOpen] = useState(false)

  // Only local rows have an activity trail in our own table.
  const parsed = parseUnifiedIssueId(item.unifiedId)
  const localId = parsed?.kind === "local" ? parsed.sourceId : null
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
        <h2 className="text-base font-semibold leading-snug">{item.title}</h2>

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
            <span className="inline-flex items-center gap-1.5">
              <IssueStatusIcon status={item.status} />
              {t(`status.${item.status}`)}
            </span>
          </PropertyRow>
          <PropertyRow label={t("detail.priority")}>
            <span className="inline-flex items-center gap-1.5">
              <IssuePriorityIcon priority={item.priority} />
              {t(`priority.${item.priority}`)}
            </span>
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
          {item.issueProjectId ? (
            <PropertyRow label={t("detail.project")}>
              {projectNamesById?.get(item.issueProjectId) ?? item.issueProjectId}
            </PropertyRow>
          ) : null}
          <PropertyRow label={t("detail.labels")}>
            {labels.length === 0 ? (
              <span className="italic opacity-70">{t("labels.none")}</span>
            ) : (
              <span className="flex flex-wrap gap-1">
                {labels.map((label) => (
                  <LabelChip key={label.id} label={label} className="h-5 text-[10px]" />
                ))}
              </span>
            )}
          </PropertyRow>
        </section>

        {item.description ? (
          <>
            <Separator />
            <section className="flex flex-col gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {t("detail.description")}
              </h3>
              <p className="whitespace-pre-wrap text-sm leading-relaxed">{item.description}</p>
            </section>
          </>
        ) : null}

        <OpenInProIde item={item} />

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
          </>
        ) : null}

        {localId ? (
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
            </section>
          </>
        ) : null}
      </div>
    </div>
  )
}

/**
 * ICU values for an activity line. Statuses and priorities are localized here
 * rather than stored localized, so a language switch relabels history too.
 */
function activityValues(
  payload: { kind: string; from?: unknown; to?: unknown },
  t: (key: string) => string
): Record<string, string> {
  const localize = (value: unknown): string => {
    if (typeof value === "string") {
      if (payload.kind === "status_changed") return t(`status.${value}`)
      if (payload.kind === "priority_changed") return t(`priority.${value}`)
      return value
    }
    if (value && typeof value === "object" && "kind" in value) {
      const actor = value as { kind: string; label?: string }
      return actor.label ?? t(`actor.${actor.kind}`)
    }
    return ""
  }
  return { from: localize(payload.from), to: localize(payload.to) }
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
function OpenInProIde({ item }: { item: UnifiedIssueItem }) {
  const t = useTranslations("issues")
  const reference = primaryFileReference(item.title, item.description)
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

  if (!reference || !root) return null

  const open = async () => {
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
    <Button
      variant="outline"
      size="sm"
      className="h-7 w-fit gap-1.5 text-xs"
      onClick={() => void open()}
      data-testid="issue-detail-open-in-pro-ide"
    >
      <FileCodeIcon className="size-3.5" />
      {t("detail.openInProIde", { path: reference.path })}
    </Button>
  )
}
