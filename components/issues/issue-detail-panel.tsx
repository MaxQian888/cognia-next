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

import { useState } from "react"
import {
  CircleSlashIcon,
  ExternalLinkIcon,
  MessageSquarePlusIcon,
  TagIcon,
  XIcon,
} from "lucide-react"
import { useTranslations } from "next-intl"

import { LabelChip } from "@/components/labels/label-chip"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { useClientLiveQuery } from "@/hooks/data"
import { parseGithubMirrorId } from "@/lib/db/github-issue-mirror"
import { listIssueEvents } from "@/lib/db/issue-events"
import { actorKey } from "@/lib/issues/board-model"
import { parseUnifiedIssueId } from "@/types/issues/unified"
import type { UnifiedIssueItem } from "@/types/issues/unified"
import type { LabelRow } from "@/types/labels"
import { GithubWritebackDialog, type GithubWritebackKind } from "./github-writeback-dialog"
import { IssuePriorityIcon, IssueStatusIcon } from "./issue-glyphs"

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
            <span
              className={!item.assignee ? "italic opacity-70" : undefined}
              data-testid={`issue-detail-assignee-${actorKey(item.assignee) ?? "none"}`}
            >
              {item.assignee
                ? (item.assignee.label ?? t(`actor.${item.assignee.kind}`))
                : t("actor.unassigned")}
            </span>
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
