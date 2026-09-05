"use client"

/**
 * Read-only issue detail for the mobile shell.
 *
 * The list already tracked a selected id — `/issues?id=…` set it — but nothing
 * consumed it beyond a background tint, so a deep link highlighted a row the
 * user could not open. This is what it opens.
 *
 * A local issue gets the phone's three writes at the bottom
 * (`IssueMobileActions`): status, assignee, comment, each queued for the host
 * as an `issue_apply_action` job. Everything else here is read: the activity
 * trail and the dispatch history sync now, and this is where they are shown.
 *
 * Only local issues have any of it. A row federated in from GitHub or an agent
 * board keeps its history and its edits in that system, so the sections stay
 * off for it and the read-only badge says so.
 */

import { useTranslations } from "next-intl"

import { IssuePriorityIcon, IssueStatusIcon } from "@/components/issues/issue-glyphs"
import { LabelChip } from "@/components/labels/label-chip"
import { Badge } from "@/components/ui/badge"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { useDexieFirstQuery } from "@/hooks/data/use-dexie-first-query"
import { listIssueEvents } from "@/lib/db/issue-events"
import { listIssueRuns } from "@/lib/db/issue-runs"
import { actorKey } from "@/lib/issues/board-model"
import { activityValues } from "@/lib/issues/activity-values"
import type { IssueEvent, IssueRun } from "@/types/issues"
import type { UnifiedIssueItem } from "@/types/issues/unified"
import type { LabelRow } from "@/types/labels"
import type { IssuePlanningHint } from "@/lib/issues/planning-hints"
import { IssueMobileActions } from "./issue-mobile-actions"

export interface IssueDetailSheetProps {
  item: UnifiedIssueItem | null
  onOpenChange: (open: boolean) => void
  labelsById: ReadonlyMap<string, LabelRow>
  projectNamesById: ReadonlyMap<string, string>
  /** Cycle names, for the planning row. Absent prints the raw id. */
  cycleNamesById?: ReadonlyMap<string, string>
  /** Every local item, so parent and blockers print identifiers, not ids. */
  items?: readonly UnifiedIssueItem[]
  hint?: IssuePlanningHint
}

export function IssueDetailSheet({
  item,
  onOpenChange,
  labelsById,
  projectNamesById,
  cycleNamesById,
  items = [],
  hint,
}: IssueDetailSheetProps) {
  const t = useTranslations("issues")

  // Only rows that live in our own tables have a trail. `localId` is null for
  // a federated row, and both queries then resolve empty without asking.
  const localId = item?.kind === "local" ? item.sourceId : null

  const events = useDexieFirstQuery({
    query: () =>
      localId
        ? listIssueEvents({ issueId: localId, descending: true, limit: 50 })
        : Promise.resolve([]),
    deps: [localId],
    initial: [] as IssueEvent[],
    table: "issueEvents",
  }).data
  const runs = useDexieFirstQuery({
    query: () => (localId ? listIssueRuns({ issueId: localId }) : Promise.resolve([])),
    deps: [localId],
    initial: [] as IssueRun[],
    table: "issueRuns",
  }).data

  const labels = (item?.labelIds ?? [])
    .map((id) => labelsById.get(id))
    .filter((label): label is LabelRow => Boolean(label))
  const identifierOf = (localId: string) =>
    items.find((candidate) => candidate.kind === "local" && candidate.sourceId === localId)
      ?.identifier ?? localId
  const parentIdentifier = item?.parentId ? identifierOf(item.parentId) : undefined
  const blockerIdentifiers = (item?.blockedBy ?? []).map(identifierOf)

  return (
    <Sheet open={item !== null} onOpenChange={onOpenChange}>
      <SheetContent side="bottom" className="max-h-[85vh] overflow-y-auto p-0">
        {item ? (
          <>
            <SheetHeader className="border-b px-4 py-3">
              <div className="flex items-center gap-2">
                <IssueStatusIcon status={item.status} />
                <span className="font-mono text-xs text-muted-foreground">{item.identifier}</span>
              </div>
              <SheetTitle className="text-left text-base leading-snug">{item.title}</SheetTitle>
            </SheetHeader>

            <div
              className="flex flex-col gap-3 px-4 py-4 text-sm"
              data-testid="issues-mobile-detail"
            >
              <Row label={t("detail.status")}>
                <span className="inline-flex items-center gap-1.5">
                  <IssueStatusIcon status={item.status} />
                  {t(`status.${item.status}`)}
                </span>
              </Row>
              <Row label={t("detail.priority")}>
                <span className="inline-flex items-center gap-1.5">
                  <IssuePriorityIcon priority={item.priority} />
                  {t(`priority.${item.priority}`)}
                </span>
              </Row>
              <Row label={t("detail.assignee")}>
                <span
                  className={!item.assignee ? "italic opacity-70" : undefined}
                  data-testid={`issues-mobile-detail-assignee-${actorKey(item.assignee) ?? "none"}`}
                >
                  {item.assignee
                    ? (item.assignee.label ?? t(`actor.${item.assignee.kind}`))
                    : t("actor.unassigned")}
                </span>
              </Row>
              {item.issueProjectId ? (
                <Row label={t("detail.project")}>
                  {projectNamesById.get(item.issueProjectId) ?? item.issueProjectId}
                </Row>
              ) : null}
              {labels.length > 0 ? (
                <Row label={t("detail.labels")}>
                  <span className="flex flex-wrap gap-1">
                    {labels.map((label) => (
                      <LabelChip key={label.id} label={label} className="h-5 text-[10px]" />
                    ))}
                  </span>
                </Row>
              ) : null}
              {item.cycleId ? (
                <Row label={t("planning.cycle")}>
                  <span data-testid="issues-mobile-detail-cycle">
                    {cycleNamesById?.get(item.cycleId) ?? item.cycleId}
                  </span>
                </Row>
              ) : null}
              {item.dueDate !== undefined ? (
                <Row label={t("planning.dueDate")}>
                  <span data-testid="issues-mobile-detail-due">
                    {new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(
                      item.dueDate
                    )}
                  </span>
                </Row>
              ) : null}
              {item.estimate !== undefined ? (
                <Row label={t("planning.estimate")}>
                  <span data-testid="issues-mobile-detail-estimate">
                    {t("planning.points", { count: item.estimate })}
                  </span>
                </Row>
              ) : null}
              {parentIdentifier ? (
                <Row label={t("planning.parent")}>
                  <span className="font-mono text-xs" data-testid="issues-mobile-detail-parent">
                    {parentIdentifier}
                  </span>
                </Row>
              ) : null}
              {blockerIdentifiers.length > 0 ? (
                <Row label={t("planning.blockedBy")}>
                  <span className="flex flex-wrap gap-1" data-testid="issues-mobile-detail-blockers">
                    {blockerIdentifiers.map((identifier) => (
                      <Badge
                        key={identifier}
                        variant={hint?.blocked ? "destructive" : "outline"}
                        className="h-5 px-1.5 font-mono text-[10px] font-normal"
                      >
                        {identifier}
                      </Badge>
                    ))}
                  </span>
                </Row>
              ) : null}
              {(item.externalRefs ?? []).length > 0 ? (
                <Row label={t("planning.links")}>
                  <ul className="flex flex-col gap-1" data-testid="issues-mobile-detail-links">
                    {(item.externalRefs ?? []).map((ref) => (
                      <li key={`${ref.provider}:${ref.externalId}`} className="truncate text-xs">
                        {ref.url ? (
                          <a
                            href={ref.url}
                            target="_blank"
                            rel="noreferrer noopener"
                            className="text-primary underline-offset-4 hover:underline"
                          >
                            {ref.label ?? ref.externalId}
                          </a>
                        ) : (
                          (ref.label ?? ref.externalId)
                        )}
                      </li>
                    ))}
                  </ul>
                </Row>
              ) : null}

              {item.description ? (
                <div className="flex flex-col gap-1.5 border-t pt-3">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {t("detail.description")}
                  </h3>
                  <p className="whitespace-pre-wrap leading-relaxed">{item.description}</p>
                </div>
              ) : null}

              {localId && (runs ?? []).length > 0 ? (
                <div className="flex flex-col gap-1.5 border-t pt-3">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {t("run.section")}
                  </h3>
                  <ol className="flex flex-col gap-1.5" data-testid="issues-mobile-detail-runs">
                    {(runs ?? []).map((run) => (
                      <li
                        key={run.id}
                        className="flex flex-col gap-1 rounded-md border px-2 py-1.5 text-xs"
                        data-testid={`issues-mobile-run-${run.status}`}
                      >
                        <span className="flex items-center gap-2">
                          <Badge
                            variant={run.status === "failed" ? "destructive" : "secondary"}
                            className="h-4 px-1 text-[10px]"
                          >
                            {t(`run.status.${run.status}`)}
                          </Badge>
                          <span className="min-w-0 truncate text-muted-foreground">
                            {t(`run.adapter.${run.adapterId}.name`)}
                          </span>
                        </span>
                        {run.summary ? (
                          <span className="text-muted-foreground">{run.summary}</span>
                        ) : null}
                        {run.error ? <span className="text-destructive">{run.error}</span> : null}
                      </li>
                    ))}
                  </ol>
                </div>
              ) : null}

              {localId && (events ?? []).length > 0 ? (
                <div className="flex flex-col gap-1.5 border-t pt-3">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {t("detail.activity")}
                  </h3>
                  <ol className="flex flex-col gap-2" data-testid="issues-mobile-detail-activity">
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
                </div>
              ) : null}

              {localId ? (
                <IssueMobileActions item={item} />
              ) : (
                // Says what mobile cannot do with a federated row, instead of
                // leaving the user hunting for controls.
                <Badge variant="outline" className="w-fit font-normal">
                  {t("detail.mobileReadOnly")}
                </Badge>
              )}
            </div>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <span className="w-20 shrink-0 text-xs text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1">{children}</span>
    </div>
  )
}
