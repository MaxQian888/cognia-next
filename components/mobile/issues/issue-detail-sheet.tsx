"use client"

/**
 * Read-only issue detail for the mobile shell.
 *
 * The list already tracked a selected id — `/issues?id=…` set it — but nothing
 * consumed it beyond a background tint, so a deep link highlighted a row the
 * user could not open. This is what it opens.
 *
 * Read-only, like everything else on mobile: writing from here means
 * registering the tracker's tables as syncable, a seven-site fan-out ending in
 * Rust (`src-tauri/src/companion_api/sync_registry.rs`). Offering controls that
 * would not round-trip is worse than offering none.
 */

import { useTranslations } from "next-intl"

import { IssuePriorityIcon, IssueStatusIcon } from "@/components/issues/issue-glyphs"
import { LabelChip } from "@/components/labels/label-chip"
import { Badge } from "@/components/ui/badge"
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet"
import { actorKey } from "@/lib/issues/board-model"
import type { UnifiedIssueItem } from "@/types/issues/unified"
import type { LabelRow } from "@/types/labels"

export interface IssueDetailSheetProps {
  item: UnifiedIssueItem | null
  onOpenChange: (open: boolean) => void
  labelsById: ReadonlyMap<string, LabelRow>
  projectNamesById: ReadonlyMap<string, string>
}

export function IssueDetailSheet({
  item,
  onOpenChange,
  labelsById,
  projectNamesById,
}: IssueDetailSheetProps) {
  const t = useTranslations("issues")

  const labels = (item?.labelIds ?? [])
    .map((id) => labelsById.get(id))
    .filter((label): label is LabelRow => Boolean(label))

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

              {item.description ? (
                <div className="flex flex-col gap-1.5 border-t pt-3">
                  <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    {t("detail.description")}
                  </h3>
                  <p className="whitespace-pre-wrap leading-relaxed">{item.description}</p>
                </div>
              ) : null}

              {/* Says what mobile cannot do, instead of leaving the user hunting. */}
              <Badge variant="outline" className="w-fit font-normal">
                {t("detail.mobileReadOnly")}
              </Badge>
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
