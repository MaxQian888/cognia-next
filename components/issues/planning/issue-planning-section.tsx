"use client"

/**
 * The inspector's planning section: cycle, due date, estimate, parent,
 * sub-issues, blockers, what this issue blocks, and links into other systems.
 *
 * Every write is an `IssueBulkAction` handed to `onAction` (spec 2026-09-06,
 * D3), so this section cannot reach a field the context menu, the agent
 * tools or the mobile RPC cannot. It renders read-only for a row whose
 * capabilities refuse edits, the same way the properties above it do.
 */

import { ExternalLinkIcon, XIcon } from "lucide-react"
import { useMemo } from "react"
import { useTranslations } from "next-intl"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import type { IssueBulkAction } from "@/lib/issues/bulk-actions"
import { issueHref } from "@/lib/issues/hrefs"
import type { IssueMenuSection } from "@/lib/issues/menu-model"
import { wouldCreateParentLoop } from "@/lib/issues/relations"
import type { IssueCycle, IssueExternalRef } from "@/types/issues"
import type { UnifiedIssueItem } from "@/types/issues/unified"
import { IssuePropertyMenu } from "../editors/issue-property-menu"
import type { MenuEntryPresentation } from "../editors/menu-entry-presentation"
import { IssuePicker, type IssuePickerCandidate } from "./issue-picker"

export interface IssuePlanningSectionProps {
  item: UnifiedIssueItem
  /** Every local item of the workspace, for the pickers and the derived lists. */
  items: readonly UnifiedIssueItem[]
  cycles: readonly IssueCycle[]
  /** The `cycle` section from `buildIssueMenuSections`, when one was built. */
  cycleSection?: IssueMenuSection
  presentation?: MenuEntryPresentation
  onAction?: (action: IssueBulkAction) => void
  onOpenIssue?: (unifiedId: string) => void
  /** Opens the create dialog with `parentId` preset. */
  onCreateSubIssue?: () => void
}

function toEpochDay(value: string): number | null {
  if (!value) return null
  const [y, m, d] = value.split("-").map(Number)
  if (!y || !m || !d) return null
  return new Date(y, m - 1, d, 12).getTime()
}

function toDateInput(dueDate: number | undefined): string {
  if (dueDate === undefined) return ""
  const date = new Date(dueDate)
  const mm = String(date.getMonth() + 1).padStart(2, "0")
  const dd = String(date.getDate()).padStart(2, "0")
  return `${date.getFullYear()}-${mm}-${dd}`
}

export function IssuePlanningSection({
  item,
  items,
  cycles,
  cycleSection,
  presentation,
  onAction,
  onOpenIssue,
  onCreateSubIssue,
}: IssuePlanningSectionProps) {
  const t = useTranslations("issues")
  const editable = Boolean(onAction) && item.capabilities.canEdit && item.kind === "local"
  const localId = item.kind === "local" ? item.sourceId : undefined

  const locals = useMemo(() => items.filter((candidate) => candidate.kind === "local"), [items])
  const byLocalId = useMemo(
    () => new Map(locals.map((candidate) => [candidate.sourceId, candidate])),
    [locals]
  )
  const relationRows = useMemo(
    () =>
      new Map(
        locals.map((candidate) => [
          candidate.sourceId,
          {
            id: candidate.sourceId,
            ...(candidate.parentId ? { parentId: candidate.parentId } : {}),
          },
        ])
      ),
    [locals]
  )

  const parent = item.parentId ? byLocalId.get(item.parentId) : undefined
  const children = useMemo(
    () => (localId ? locals.filter((candidate) => candidate.parentId === localId) : []),
    [locals, localId]
  )
  const blockedBy = useMemo(
    () =>
      (item.blockedBy ?? [])
        .map((id) => byLocalId.get(id))
        .filter((row): row is UnifiedIssueItem => Boolean(row)),
    [item.blockedBy, byLocalId]
  )
  const blocks = useMemo(
    () =>
      localId ? locals.filter((candidate) => (candidate.blockedBy ?? []).includes(localId)) : [],
    [locals, localId]
  )
  const cycle = item.cycleId ? cycles.find((candidate) => candidate.id === item.cycleId) : undefined

  const parentCandidates: IssuePickerCandidate[] = useMemo(
    () =>
      locals
        .filter((candidate) => candidate.sourceId !== localId)
        .map((candidate) => ({
          id: candidate.sourceId,
          identifier: candidate.identifier,
          title: candidate.title,
          status: candidate.status,
          disabled: localId
            ? wouldCreateParentLoop(localId, candidate.sourceId, relationRows)
            : false,
        })),
    [locals, localId, relationRows]
  )
  const blockerCandidates: IssuePickerCandidate[] = useMemo(
    () =>
      locals
        .filter((candidate) => candidate.sourceId !== localId)
        .map((candidate) => ({
          id: candidate.sourceId,
          identifier: candidate.identifier,
          title: candidate.title,
          status: candidate.status,
          disabled: (item.blockedBy ?? []).includes(candidate.sourceId),
        })),
    [locals, localId, item.blockedBy]
  )

  const refs: readonly IssueExternalRef[] = item.externalRefs ?? []

  return (
    <section className="flex flex-col gap-2" data-testid="issue-planning-section">
      <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {t("planning.section")}
      </h3>

      <PropertyRow label={t("planning.cycle")}>
        {cycleSection && presentation && onAction && editable ? (
          <IssuePropertyMenu
            section={cycleSection}
            presentation={presentation}
            onAction={onAction}
            testId="issue-detail-cycle"
          >
            <span className={!cycle ? "italic opacity-70" : undefined}>
              {cycle ? cycle.name : t("planning.noCycle")}
            </span>
          </IssuePropertyMenu>
        ) : (
          <span
            className={!cycle ? "italic opacity-70" : undefined}
            data-testid="issue-detail-cycle-static"
          >
            {cycle ? cycle.name : t("planning.noCycle")}
          </span>
        )}
      </PropertyRow>

      <PropertyRow label={t("planning.dueDate")}>
        {editable ? (
          <span className="flex items-center gap-1">
            <Input
              type="date"
              value={toDateInput(item.dueDate)}
              onChange={(event) =>
                onAction?.({ kind: "dueDate", to: toEpochDay(event.target.value) })
              }
              aria-label={t("planning.dueDate")}
              className="h-7 w-40 text-xs"
              data-testid="issue-detail-due-date"
            />
            {item.dueDate !== undefined ? (
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={t("planning.clearDueDate")}
                onClick={() => onAction?.({ kind: "dueDate", to: null })}
                data-testid="issue-detail-due-date-clear"
              >
                <XIcon className="size-3" />
              </Button>
            ) : null}
          </span>
        ) : (
          <span className={item.dueDate === undefined ? "italic opacity-70" : undefined}>
            {item.dueDate === undefined
              ? t("planning.noDueDate")
              : new Intl.DateTimeFormat(undefined, { dateStyle: "medium" }).format(item.dueDate)}
          </span>
        )}
      </PropertyRow>

      <PropertyRow label={t("planning.estimate")}>
        {editable ? (
          <Input
            type="number"
            min={0}
            step={1}
            inputMode="numeric"
            value={item.estimate ?? ""}
            placeholder={t("planning.estimatePlaceholder")}
            onChange={(event) => {
              const raw = event.target.value
              onAction?.({ kind: "estimate", to: raw === "" ? null : Number(raw) })
            }}
            aria-label={t("planning.estimate")}
            className="h-7 w-24 text-xs"
            data-testid="issue-detail-estimate"
          />
        ) : (
          <span className={item.estimate === undefined ? "italic opacity-70" : undefined}>
            {item.estimate === undefined
              ? t("planning.noEstimate")
              : t("planning.points", { count: item.estimate })}
          </span>
        )}
      </PropertyRow>

      <PropertyRow label={t("planning.parent")}>
        <span className="flex min-w-0 flex-wrap items-center gap-1">
          {parent ? (
            <IssueChip
              item={parent}
              onOpen={onOpenIssue}
              onRemove={editable ? () => onAction?.({ kind: "parent", parentId: null }) : undefined}
              removeLabel={t("planning.clearParent")}
              testId={`issue-detail-parent-${parent.sourceId}`}
            />
          ) : (
            <span className="italic opacity-70">{t("planning.noParent")}</span>
          )}
          {editable ? (
            <IssuePicker
              candidates={parentCandidates}
              value={item.parentId}
              onPick={(parentId) => onAction?.({ kind: "parent", parentId })}
              triggerLabel={t("planning.pickParent")}
              testId="issue-detail-parent-picker"
            />
          ) : null}
        </span>
      </PropertyRow>

      <PropertyRow label={t("planning.subIssues")}>
        <span className="flex min-w-0 flex-col gap-1">
          {children.length === 0 ? (
            <span className="italic opacity-70">{t("planning.noSubIssues")}</span>
          ) : (
            <ul className="flex flex-col gap-0.5" data-testid="issue-detail-subissues">
              {children.map((child) => (
                <li key={child.unifiedId}>
                  <IssueChip
                    item={child}
                    onOpen={onOpenIssue}
                    testId={`issue-detail-subissue-${child.sourceId}`}
                  />
                </li>
              ))}
            </ul>
          )}
          {editable && onCreateSubIssue ? (
            <Button
              size="sm"
              variant="outline"
              className="h-6 w-fit text-xs"
              onClick={onCreateSubIssue}
              data-testid="issue-detail-add-subissue"
            >
              {t("planning.addSubIssue")}
            </Button>
          ) : null}
        </span>
      </PropertyRow>

      <PropertyRow label={t("planning.blockedBy")}>
        <span className="flex min-w-0 flex-wrap items-center gap-1">
          {blockedBy.length === 0 ? (
            <span className="italic opacity-70">{t("planning.noBlockers")}</span>
          ) : (
            blockedBy.map((blocker) => (
              <IssueChip
                key={blocker.unifiedId}
                item={blocker}
                onOpen={onOpenIssue}
                onRemove={
                  editable
                    ? () => onAction?.({ kind: "removeBlocker", blockerId: blocker.sourceId })
                    : undefined
                }
                removeLabel={t("planning.removeBlocker")}
                testId={`issue-detail-blocker-${blocker.sourceId}`}
              />
            ))
          )}
          {editable ? (
            <IssuePicker
              candidates={blockerCandidates}
              onPick={(blockerId) => onAction?.({ kind: "addBlocker", blockerId })}
              triggerLabel={t("planning.addBlocker")}
              testId="issue-detail-blocker-picker"
            />
          ) : null}
        </span>
      </PropertyRow>

      {blocks.length > 0 ? (
        <PropertyRow label={t("planning.blocks")}>
          <span
            className="flex min-w-0 flex-wrap items-center gap-1"
            data-testid="issue-detail-blocks"
          >
            {blocks.map((blocked) => (
              <IssueChip
                key={blocked.unifiedId}
                item={blocked}
                onOpen={onOpenIssue}
                testId={`issue-detail-blocks-${blocked.sourceId}`}
              />
            ))}
          </span>
        </PropertyRow>
      ) : null}

      {refs.length > 0 ? (
        <PropertyRow label={t("planning.links")}>
          <ul className="flex min-w-0 flex-col gap-1" data-testid="issue-detail-external-refs">
            {refs.map((ref) => (
              <li key={`${ref.provider}:${ref.externalId}`} className="flex items-center gap-1">
                <Badge variant="outline" className="h-5 shrink-0 px-1.5 text-[10px] font-normal">
                  {t(`planning.provider.${providerKey(ref.provider)}`)}
                </Badge>
                {ref.url ? (
                  <a
                    href={ref.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="inline-flex min-w-0 items-center gap-1 truncate text-xs text-primary underline-offset-4 hover:underline"
                  >
                    <span className="truncate">{ref.label ?? ref.externalId}</span>
                    <ExternalLinkIcon aria-hidden className="size-3 shrink-0" />
                  </a>
                ) : (
                  <span className="truncate text-xs">{ref.label ?? ref.externalId}</span>
                )}
                {editable ? (
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={t("planning.unlink")}
                    onClick={() =>
                      onAction?.({
                        kind: "unlinkExternal",
                        ref: { provider: ref.provider, externalId: ref.externalId },
                      })
                    }
                    data-testid={`issue-detail-unlink-${ref.provider}-${ref.externalId}`}
                  >
                    <XIcon className="size-3" />
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </PropertyRow>
      ) : null}
    </section>
  )
}

/**
 * Provider ids are open strings (a plugin brings its own), so the label key
 * falls back to `other` for anything the catalogue does not name.
 */
const KNOWN_PROVIDERS = new Set([
  "github",
  "github-pr",
  "lark-task",
  "lark-bitable",
  "import:csv",
  "import:json",
  "import:markdown",
])

export function providerKey(provider: string): string {
  return KNOWN_PROVIDERS.has(provider) ? provider.replace(":", "_") : "other"
}

function PropertyRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 text-sm">
      <span className="w-20 shrink-0 text-xs text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1">{children}</span>
    </div>
  )
}

function IssueChip({
  item,
  onOpen,
  onRemove,
  removeLabel,
  testId,
}: {
  item: UnifiedIssueItem
  onOpen?: (unifiedId: string) => void
  onRemove?: () => void
  removeLabel?: string
  testId: string
}) {
  return (
    <span
      className="inline-flex h-6 max-w-full items-center gap-1 rounded-md border px-1.5 text-xs"
      data-testid={testId}
    >
      {onOpen ? (
        <button
          type="button"
          onClick={() => onOpen(item.unifiedId)}
          className="inline-flex min-w-0 items-center gap-1 hover:underline"
        >
          <span className="font-mono text-[11px] text-muted-foreground">{item.identifier}</span>
          <span className="truncate">{item.title}</span>
        </button>
      ) : (
        <a href={issueHref(item.sourceId)} className="inline-flex min-w-0 items-center gap-1">
          <span className="font-mono text-[11px] text-muted-foreground">{item.identifier}</span>
          <span className="truncate">{item.title}</span>
        </a>
      )}
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          aria-label={removeLabel}
          className="rounded-sm opacity-60 hover:opacity-100"
          data-testid={`${testId}-remove`}
        >
          <XIcon className="size-3" />
        </button>
      ) : null}
    </span>
  )
}
