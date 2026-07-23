"use client"

import { useState } from "react"
import { useFormatter, useNow, useTranslations } from "next-intl"
import Link from "next/link"
import {
  ChevronDownIcon,
  ChevronUpIcon,
  PencilIcon,
  PinIcon,
  PinOffIcon,
  Trash2Icon,
  XIcon,
  CheckIcon,
  ArrowUpRightIcon,
  TriangleAlertIcon,
} from "lucide-react"
import type { Memory } from "@/types/memory/memory"
import type { MemoryAuditEvent, MemoryEvidence } from "@/types/memory/governance"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Slider } from "@/components/ui/slider"
import { Textarea } from "@/components/ui/textarea"
import { ConfirmActionDialog } from "@/components/agent/workspace/settings/confirm-action-dialog"

export interface MemoryDetailPatch {
  text?: string
  tags?: string[]
  importance?: number
}

export interface MemoryDetailPanelProps {
  memory: Memory
  /** Resolve a related memory id (superseded chain) to a row, if loaded. */
  resolveMemory?: (id: string) => Memory | undefined
  onClose: () => void
  onSave: (id: string, patch: MemoryDetailPatch) => void
  onPinToggle: (id: string, pinned: boolean) => void
  onDelete: (id: string) => void
  onReview?: (id: string, status: "verified" | "conflict") => void
  evidence?: MemoryEvidence[]
  auditEvents?: MemoryAuditEvent[]
  /** Step to the previous/next memory in the filtered list. */
  onNavigate?: (delta: -1 | 1) => void
  /** 1-based position within the filtered list, for the nav readout. */
  navPosition?: { index: number; total: number }
  /** Jump the panel to another memory (superseded-chain link). */
  onSelectMemory?: (id: string) => void
  /** Open the guided conflict-disposition card for this memory's conflict pair. */
  onOpenResolver?: () => void
  className?: string
}

function parseTags(raw: string): string[] {
  const seen = new Set<string>()
  for (const part of raw.split(",")) {
    const trimmed = part.trim()
    if (trimmed) seen.add(trimmed)
  }
  return [...seen]
}

/**
 * Rich detail sidebar for a single memory — the `/memory` counterpart to the
 * log panel's `LogDetailPanel`. Surfaces every field the list hides (scope,
 * provenance, version, access count, timestamps, source, superseded chain) and
 * hosts an inline edit mode for text / tags / importance. Keyed by memory id in
 * the console, so navigating remounts and resets the local edit drafts.
 */
export function MemoryDetailPanel({
  memory,
  resolveMemory,
  onClose,
  onSave,
  onPinToggle,
  onDelete,
  onReview,
  evidence = [],
  auditEvents = [],
  onNavigate,
  navPosition,
  onSelectMemory,
  onOpenResolver,
  className,
}: MemoryDetailPanelProps) {
  const t = useTranslations("memory.detail")
  const tPanel = useTranslations("memory.panel")
  const tConflicts = useTranslations("memory.conflicts")
  const tGovernance = useTranslations("memory.governance")
  const tTypes = useTranslations("memory.types")
  const tScopes = useTranslations("memory.scopes")
  const tProv = useTranslations("memory.provenance")
  const format = useFormatter()
  const now = useNow()

  const [editing, setEditing] = useState(false)
  const [textDraft, setTextDraft] = useState(memory.text)
  const [tagsDraft, setTagsDraft] = useState(memory.tags.join(", "))
  const [importanceDraft, setImportanceDraft] = useState(memory.importance)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const invalidated = memory.status === "invalidated"
  const supersededBy = memory.supersededById ? resolveMemory?.(memory.supersededById) : undefined

  const beginEdit = () => {
    setTextDraft(memory.text)
    setTagsDraft(memory.tags.join(", "))
    setImportanceDraft(memory.importance)
    setEditing(true)
  }

  const commitEdit = () => {
    const patch: MemoryDetailPatch = {}
    const trimmed = textDraft.trim()
    if (trimmed && trimmed !== memory.text) patch.text = trimmed
    const nextTags = parseTags(tagsDraft)
    if (nextTags.join("\u0000") !== memory.tags.join("\u0000")) patch.tags = nextTags
    if (importanceDraft !== memory.importance) patch.importance = importanceDraft
    if (Object.keys(patch).length > 0) onSave(memory.id, patch)
    setEditing(false)
  }

  const abs = (ts: number) =>
    format.dateTime(new Date(ts), { dateStyle: "medium", timeStyle: "short" })
  const rel = (ts: number) => format.relativeTime(new Date(ts), now)

  return (
    <div
      className={cn("flex h-full min-h-0 flex-col bg-card/60", className)}
      data-testid="memory-detail-panel"
    >
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-border/50 px-3 py-2">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          <Badge variant="secondary" className="text-[10px]">
            {tTypes(memory.type)}
          </Badge>
          <Badge variant="outline" className="text-[10px]">
            {tScopes(memory.scope)}
          </Badge>
          <Badge variant="outline" className="text-[10px]">
            {tProv(memory.provenance)}
          </Badge>
          {invalidated && (
            <Badge variant="destructive" className="text-[10px]">
              {tPanel("invalidated")}
            </Badge>
          )}
        </div>
        {onNavigate && navPosition && (
          <div className="flex shrink-0 items-center gap-0.5">
            <Button
              size="icon"
              variant="ghost"
              className="size-7"
              aria-label={t("previous")}
              disabled={navPosition.index <= 1}
              onClick={() => onNavigate(-1)}
            >
              <ChevronUpIcon className="size-4" />
            </Button>
            <span
              className="tabular-nums text-[11px] text-muted-foreground"
              data-testid="memory-detail-nav"
            >
              {navPosition.index}/{navPosition.total}
            </span>
            <Button
              size="icon"
              variant="ghost"
              className="size-7"
              aria-label={t("next")}
              disabled={navPosition.index >= navPosition.total}
              onClick={() => onNavigate(1)}
            >
              <ChevronDownIcon className="size-4" />
            </Button>
          </div>
        )}
        <Button
          size="icon"
          variant="ghost"
          className="size-7 shrink-0"
          aria-label={t("close")}
          onClick={onClose}
        >
          <XIcon className="size-4" />
        </Button>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-4 p-3">
          {/* Text / edit */}
          <section className="flex flex-col gap-2">
            {editing ? (
              <>
                <Label htmlFor="mem-detail-text" className="text-xs text-muted-foreground">
                  {t("textLabel")}
                </Label>
                <Textarea
                  id="mem-detail-text"
                  aria-label={t("textLabel")}
                  value={textDraft}
                  onChange={(e) => setTextDraft(e.target.value)}
                  rows={4}
                  className="text-sm"
                />
                <Label htmlFor="mem-detail-tags" className="text-xs text-muted-foreground">
                  {t("tagsLabel")}
                </Label>
                <Input
                  id="mem-detail-tags"
                  aria-label={t("tagsLabel")}
                  value={tagsDraft}
                  onChange={(e) => setTagsDraft(e.target.value)}
                  placeholder={t("tagsPlaceholder")}
                  className="text-sm"
                />
                <div className="flex items-center justify-between gap-3">
                  <Label className="text-xs text-muted-foreground">{t("importanceLabel")}</Label>
                  <span className="tabular-nums text-sm font-medium">{importanceDraft}</span>
                </div>
                <Slider
                  aria-label={t("importanceLabel")}
                  min={1}
                  max={10}
                  step={1}
                  value={[importanceDraft]}
                  onValueChange={(v) => setImportanceDraft(v[0] ?? memory.importance)}
                />
                <div className="flex items-center gap-2">
                  <Button size="sm" onClick={commitEdit}>
                    <CheckIcon className="size-4" />
                    {t("save")}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setEditing(false)}>
                    {t("cancel")}
                  </Button>
                </div>
              </>
            ) : (
              <p
                className={cn(
                  "break-words text-sm leading-relaxed",
                  invalidated && "line-through opacity-70"
                )}
                data-testid="memory-detail-text"
              >
                {memory.text}
              </p>
            )}
          </section>

          {!editing && memory.tags.length > 0 && (
            <div className="flex flex-wrap items-center gap-1" data-testid="memory-detail-tags">
              {memory.tags.map((tag) => (
                <span
                  key={tag}
                  className="rounded-full border border-border/60 px-2 py-0.5 text-[11px] text-muted-foreground"
                >
                  #{tag}
                </span>
              ))}
            </div>
          )}

          {/* Metadata */}
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
            <Field label={t("fields.evidence")}>
              {tGovernance(memory.evidenceState ?? "legacy")}
            </Field>
            <Field label={t("fields.review")}>
              {tGovernance(memory.reviewStatus ?? "unreviewed")}
            </Field>
            <Field label={t("fields.contamination")}>
              {tGovernance(memory.contaminationState ?? "unknown")}
            </Field>
            <Field label={t("fields.scope")}>{tScopes(memory.scope)}</Field>
            <Field label={t("fields.importance")}>
              <span className="tabular-nums">★ {memory.importance}/10</span>
            </Field>
            <Field label={t("fields.version")}>
              <span className="tabular-nums">v{memory.version}</span>
            </Field>
            <Field label={t("fields.accessCount")}>
              <span className="tabular-nums">{memory.accessCount}</span>
            </Field>
            <Field label={t("fields.indexed")}>
              <span>{memory.vectorDocId ? t("yes") : t("no")}</span>
            </Field>
            {memory.key && (
              <Field label={t("fields.key")} className="col-span-2">
                <code className="break-all rounded bg-muted px-1 py-0.5 text-[11px]">
                  {memory.key}
                </code>
              </Field>
            )}
            <Field label={t("fields.created")}>
              <time title={abs(memory.createdAt)}>{rel(memory.createdAt)}</time>
            </Field>
            <Field label={t("fields.updated")}>
              <time title={abs(memory.updatedAt)}>{rel(memory.updatedAt)}</time>
            </Field>
            <Field label={t("fields.lastUsed")}>
              <time title={abs(memory.lastAccessedAt)}>{rel(memory.lastAccessedAt)}</time>
            </Field>
            {invalidated && memory.invalidatedAt && (
              <Field label={t("fields.archivedAt")}>
                <time title={abs(memory.invalidatedAt)}>{rel(memory.invalidatedAt)}</time>
              </Field>
            )}
          </dl>

          {onReview && (
            <div className="flex flex-wrap gap-2 border-t border-border/50 pt-3">
              <Button
                size="sm"
                variant={memory.reviewStatus === "verified" ? "secondary" : "default"}
                onClick={() => onReview(memory.id, "verified")}
              >
                {tGovernance("markVerified")}
              </Button>
              <Button
                size="sm"
                variant={memory.reviewStatus === "conflict" ? "destructive" : "outline"}
                onClick={() => onReview(memory.id, "conflict")}
              >
                {tGovernance("markConflict")}
              </Button>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3 border-t border-border/50 pt-3 text-xs">
            <div>
              <span className="font-medium text-muted-foreground">{t("evidenceTitle")}</span>
              <p className="mt-1 tabular-nums" data-testid="memory-detail-evidence-count">
                {t("recordCount", { count: evidence.length })}
              </p>
            </div>
            <div>
              <span className="font-medium text-muted-foreground">{t("auditTitle")}</span>
              <p className="mt-1 tabular-nums" data-testid="memory-detail-audit-count">
                {t("recordCount", { count: auditEvents.length })}
              </p>
            </div>
          </div>

          {memory.conflictWithIds && memory.conflictWithIds.length > 0 && (
            <div className="flex flex-col gap-1 border-t border-border/50 pt-3">
              <span className="text-xs font-medium text-muted-foreground">
                {t("conflictsWith")}
              </span>
              {memory.conflictWithIds.map((id) => {
                const conflict = resolveMemory?.(id)
                return conflict ? (
                  <button
                    key={id}
                    type="button"
                    onClick={() => onSelectMemory?.(id)}
                    disabled={!onSelectMemory}
                    className="w-fit text-left text-xs text-primary hover:underline disabled:text-muted-foreground"
                  >
                    {conflict.text}
                  </button>
                ) : (
                  <span key={id} className="text-xs text-muted-foreground">
                    {t("conflictGone")}
                  </span>
                )
              })}
              {onOpenResolver && (
                <Button
                  size="sm"
                  variant="outline"
                  className="mt-1 w-fit"
                  onClick={onOpenResolver}
                  data-testid="memory-detail-open-resolver"
                >
                  <TriangleAlertIcon className="size-3.5 text-red-500" />
                  {tConflicts("openResolver")}
                </Button>
              )}
            </div>
          )}

          {/* Source */}
          {memory.sourceSessionId && (
            <div className="flex flex-col gap-1 border-t border-border/50 pt-3">
              <span className="text-xs font-medium text-muted-foreground">{t("source")}</span>
              <Link
                href={`/?session=${memory.sourceSessionId}`}
                className="inline-flex w-fit items-center gap-1 text-xs text-primary hover:underline"
                data-testid="memory-detail-source-link"
              >
                <ArrowUpRightIcon className="size-3.5" />
                {tPanel("viewSource")}
              </Link>
            </div>
          )}

          {/* Superseded chain */}
          {memory.supersededById && (
            <div className="flex flex-col gap-1 border-t border-border/50 pt-3">
              <span className="text-xs font-medium text-muted-foreground">{t("replacedBy")}</span>
              {supersededBy ? (
                <button
                  type="button"
                  onClick={() => onSelectMemory?.(supersededBy.id)}
                  disabled={!onSelectMemory}
                  className="w-fit text-left text-xs text-primary hover:underline disabled:text-muted-foreground disabled:no-underline"
                  data-testid="memory-detail-superseded-link"
                >
                  {supersededBy.text}
                </button>
              ) : (
                <span className="text-xs text-muted-foreground">{t("replacedByGone")}</span>
              )}
            </div>
          )}
        </div>
      </ScrollArea>

      {/* Footer actions */}
      <div className="flex items-center gap-1 border-t border-border/50 px-3 py-2">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => onPinToggle(memory.id, !memory.pinned)}
          aria-label={memory.pinned ? tPanel("unpin") : tPanel("pin")}
        >
          {memory.pinned ? <PinOffIcon className="size-4" /> : <PinIcon className="size-4" />}
          {memory.pinned ? tPanel("unpin") : tPanel("pin")}
        </Button>
        {!editing && (
          <Button size="sm" variant="ghost" onClick={beginEdit} aria-label={tPanel("edit")}>
            <PencilIcon className="size-4" />
            {tPanel("edit")}
          </Button>
        )}
        <div className="flex-1" />
        <Button
          size="sm"
          variant="ghost"
          className="text-destructive hover:text-destructive"
          onClick={() => setConfirmDelete(true)}
          aria-label={tPanel("delete")}
        >
          <Trash2Icon className="size-4" />
          {tPanel("delete")}
        </Button>
      </div>

      <ConfirmActionDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={t("deleteConfirm.title")}
        description={t("deleteConfirm.description")}
        confirmLabel={t("deleteConfirm.confirm")}
        cancelLabel={t("deleteConfirm.cancel")}
        tone="destructive"
        onConfirm={() => {
          onDelete(memory.id)
          onClose()
        }}
      />
    </div>
  )
}

function Field({
  label,
  children,
  className,
}: {
  label: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn("flex flex-col gap-0.5", className)}>
      <dt className="text-[10px] uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="text-foreground">{children}</dd>
    </div>
  )
}
