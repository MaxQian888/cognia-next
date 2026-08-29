"use client"

/**
 * Inspector for one memory — the right pane of `/memory`.
 *
 * Replaces a flat two-column `<dl>` of a dozen fields with named sections, and
 * fixes a real gap while doing it: the panel this supersedes live-queried the
 * memory's evidence and audit rows and then rendered only `.length`. The data
 * was fetched and thrown away, so the one question the inspector exists to
 * answer — *where did this come from and what has happened to it* — was the one
 * it could not answer. The Activity section renders those rows.
 *
 * Keyed by memory id in the console, so navigating remounts and resets drafts.
 */

import { useState } from "react"
import { useFormatter, useNow, useTranslations } from "next-intl"
import Link from "next/link"
import { buildSessionHref } from "@/lib/chat/message-permalink"
import { MentionBacklinksPanel } from "@/components/chat/mention-backlinks-chip"
import { entityBacklinkTarget } from "@/lib/chat/mentions/backlinks"
import {
  ArchiveIcon,
  ArrowUpRightIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PinIcon,
  PinOffIcon,
  Trash2Icon,
  TriangleAlertIcon,
  XIcon,
} from "lucide-react"

import type { Memory } from "@/types/memory/memory"
import type { MemoryAuditEvent, MemoryEvidence } from "@/types/memory/governance"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Slider } from "@/components/ui/slider"
import { Textarea } from "@/components/ui/textarea"
import { ConfirmActionDialog } from "@/components/agent/workspace/settings/confirm-action-dialog"

export interface MemoryInspectorPatch {
  text?: string
  tags?: string[]
  importance?: number
}

export interface MemoryInspectorProps {
  memory: Memory
  /** Resolve a related memory id (superseded chain) to a row, if loaded. */
  resolveMemory?: (id: string) => Memory | undefined
  onClose: () => void
  onSave: (id: string, patch: MemoryInspectorPatch) => void
  /** Called with the *desired* pinned state, not the current one. */
  onPinToggle: (id: string, pinned: boolean) => void
  /** Soft delete — keeps history, restorable from the Archived view. */
  onArchive: (id: string) => void
  /** Permanent delete. Confirmed inside this component. */
  onDelete: (id: string) => void
  onReview?: (id: string, status: "verified" | "conflict") => void
  evidence?: readonly MemoryEvidence[]
  auditEvents?: readonly MemoryAuditEvent[]
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

export function MemoryInspector({
  memory,
  resolveMemory,
  onClose,
  onSave,
  onPinToggle,
  onArchive,
  onDelete,
  onReview,
  evidence = [],
  auditEvents = [],
  onNavigate,
  navPosition,
  onSelectMemory,
  onOpenResolver,
  className,
}: MemoryInspectorProps) {
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
  const [confirmArchive, setConfirmArchive] = useState(false)

  const invalidated = memory.status === "invalidated"
  const review = memory.reviewStatus ?? "unreviewed"
  const supersededBy = memory.supersededById ? resolveMemory?.(memory.supersededById) : undefined
  const conflictIds = memory.conflictWithIds ?? []

  const beginEdit = () => {
    setTextDraft(memory.text)
    setTagsDraft(memory.tags.join(", "))
    setImportanceDraft(memory.importance)
    setEditing(true)
  }

  const commit = () => {
    const text = textDraft.trim()
    if (!text) return
    onSave(memory.id, { text, tags: parseTags(tagsDraft), importance: importanceDraft })
    setEditing(false)
  }

  const at = (ts: number) =>
    format.dateTime(new Date(ts), { dateStyle: "medium", timeStyle: "short" })
  const since = (ts: number) => format.relativeTime(new Date(ts), now)

  const timeline = buildTimeline(evidence, auditEvents)

  return (
    <div
      className={cn("flex h-full min-h-0 flex-col", className)}
      data-testid="memory-inspector"
      data-memory-id={memory.id}
    >
      <header className="flex shrink-0 flex-wrap items-center gap-1.5 border-b px-3 py-2">
        <Badge variant="outline" className="font-normal">
          {tTypes(memory.type)}
        </Badge>
        <Badge variant="secondary" className="font-normal">
          {tScopes(memory.scope)}
        </Badge>
        {invalidated ? (
          <Badge variant="secondary" className="font-normal">
            {tPanel("invalidated")}
          </Badge>
        ) : null}
        <span className="flex-1" />
        {onNavigate && navPosition ? (
          <div className="flex items-center gap-0.5 text-xs text-muted-foreground">
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={t("previous")}
              disabled={navPosition.index <= 1}
              onClick={() => onNavigate(-1)}
            >
              <ChevronUpIcon className="size-4" />
            </Button>
            <span className="tabular-nums">
              {navPosition.index}/{navPosition.total}
            </span>
            <Button
              size="icon-sm"
              variant="ghost"
              aria-label={t("next")}
              disabled={navPosition.index >= navPosition.total}
              onClick={() => onNavigate(1)}
            >
              <ChevronDownIcon className="size-4" />
            </Button>
          </div>
        ) : null}
        <Button size="icon-sm" variant="ghost" aria-label={t("close")} onClick={onClose}>
          <XIcon className="size-4" />
        </Button>
      </header>

      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-4 p-3">
          <Section title={t("sections.content")}>
            {editing ? (
              <div className="flex flex-col gap-3">
                <Textarea
                  value={textDraft}
                  onChange={(event) => setTextDraft(event.target.value)}
                  rows={5}
                  aria-label={t("textLabel")}
                  autoFocus
                />
                <div className="flex flex-col gap-1.5">
                  <Label htmlFor="memory-inspector-tags">{t("tagsLabel")}</Label>
                  <Input
                    id="memory-inspector-tags"
                    value={tagsDraft}
                    onChange={(event) => setTagsDraft(event.target.value)}
                    placeholder={t("tagsPlaceholder")}
                  />
                </div>
                <div className="flex flex-col gap-1.5">
                  <div className="flex items-center justify-between">
                    <Label>{t("importanceLabel")}</Label>
                    <span className="text-sm font-medium tabular-nums">{importanceDraft}</span>
                  </div>
                  <Slider
                    aria-label={t("importanceLabel")}
                    min={1}
                    max={10}
                    step={1}
                    value={[importanceDraft]}
                    onValueChange={(value) => setImportanceDraft(value[0] ?? memory.importance)}
                  />
                </div>
                <div className="flex items-center gap-2">
                  <Button size="sm" onClick={commit} disabled={!textDraft.trim()}>
                    <CheckIcon className="size-4" />
                    {t("save")}
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                    {t("cancel")}
                  </Button>
                </div>
              </div>
            ) : (
              <p className="text-sm leading-relaxed whitespace-pre-wrap">{memory.text}</p>
            )}
          </Section>

          {!editing && memory.tags.length > 0 ? (
            <Section title={t("sections.tags")}>
              <div className="flex flex-wrap gap-1">
                {memory.tags.map((tag) => (
                  <Badge key={tag} variant="secondary" className="font-normal">
                    {tag}
                  </Badge>
                ))}
              </div>
            </Section>
          ) : null}

          <Section title={t("sections.status")}>
            <div className="flex flex-wrap items-center gap-1.5">
              <Badge
                variant={review === "conflict" ? "destructive" : "outline"}
                className="font-normal"
                data-testid="memory-inspector-review"
              >
                {tGovernance(review)}
              </Badge>
              <Badge variant="outline" className="font-normal">
                {tGovernance(memory.evidenceState ?? "legacy")}
              </Badge>
              <Badge variant="outline" className="font-normal">
                {tGovernance(memory.contaminationState ?? "unknown")}
              </Badge>
            </div>
            {onReview && !invalidated ? (
              <div className="mt-2 flex flex-wrap items-center gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onReview(memory.id, "verified")}
                  disabled={review === "verified"}
                  data-testid="memory-inspector-verify"
                >
                  {tGovernance("markVerified")}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onReview(memory.id, "conflict")}
                  disabled={review === "conflict"}
                >
                  {tGovernance("markConflict")}
                </Button>
              </div>
            ) : null}
            {conflictIds.length > 0 ? (
              <div className="mt-2 flex flex-col gap-1.5 rounded-md border border-destructive/40 bg-destructive/5 p-2">
                <p className="flex items-center gap-1.5 text-xs font-medium text-destructive">
                  <TriangleAlertIcon className="size-3.5" aria-hidden="true" />
                  {t("conflictsWith")}
                </p>
                {conflictIds.map((id) => {
                  const other = resolveMemory?.(id)
                  return (
                    <button
                      key={id}
                      type="button"
                      className="truncate text-left text-xs underline-offset-2 hover:underline disabled:no-underline disabled:opacity-60"
                      disabled={!other || !onSelectMemory}
                      onClick={() => onSelectMemory?.(id)}
                    >
                      {other?.text ?? t("conflictGone")}
                    </button>
                  )
                })}
                {onOpenResolver ? (
                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-1 self-start"
                    onClick={onOpenResolver}
                  >
                    {tConflicts("openResolver")}
                  </Button>
                ) : null}
              </div>
            ) : null}
          </Section>

          <Section title={t("sections.origin")}>
            <FieldGrid>
              <Field label={t("fields.scope")} value={tScopes(memory.scope)} />
              <Field label={tPanel("provenanceLabel")} value={tProv(memory.provenance)} />
              {memory.key ? <Field label={t("fields.key")} value={memory.key} mono /> : null}
              <Field label={t("fields.created")} value={at(memory.createdAt)} />
              <Field label={t("fields.updated")} value={at(memory.updatedAt)} />
              {memory.invalidatedAt ? (
                <Field label={t("fields.archivedAt")} value={at(memory.invalidatedAt)} />
              ) : null}
            </FieldGrid>
            {memory.sourceSessionId ? (
              <Button size="sm" variant="ghost" className="mt-1.5 h-7 px-2" asChild>
                {/* The message, not just the conversation — see memory-row. */}
                <Link href={buildSessionHref(memory.sourceSessionId, memory.sourceMessageId)}>
                  <ArrowUpRightIcon className="size-3.5" />
                  {t("source")}
                </Link>
              </Button>
            ) : null}
            {/* Which conversations have actually reached for this memory —
                the question that decides whether it still earns its place. */}
            <MentionBacklinksPanel target={entityBacklinkTarget("memory", memory.id)} />
            {memory.supersededById ? (
              <p className="mt-1.5 text-xs text-muted-foreground">
                {t("replacedBy")}:{" "}
                {supersededBy && onSelectMemory ? (
                  <button
                    type="button"
                    className="underline-offset-2 hover:underline"
                    onClick={() => onSelectMemory(memory.supersededById!)}
                  >
                    {supersededBy.text}
                  </button>
                ) : (
                  t("replacedByGone")
                )}
              </p>
            ) : null}
          </Section>

          <Section title={t("sections.metrics")}>
            <FieldGrid>
              <Field label={t("fields.importance")} value={String(memory.importance)} />
              <Field label={t("fields.version")} value={String(memory.version)} />
              <Field label={t("fields.accessCount")} value={String(memory.accessCount)} />
              <Field label={t("fields.lastUsed")} value={since(memory.lastAccessedAt)} />
              <Field label={t("fields.indexed")} value={memory.vectorDocId ? t("yes") : t("no")} />
            </FieldGrid>
          </Section>

          <Section title={t("sections.activity")}>
            {timeline.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t("activity.empty")}</p>
            ) : (
              <ol className="flex flex-col gap-2" data-testid="memory-activity">
                {timeline.map((entry) => (
                  <li key={entry.key} className="flex items-start gap-2 text-xs">
                    <span
                      className={cn(
                        "mt-1.5 size-1.5 shrink-0 rounded-full",
                        entry.source === "audit" ? "bg-primary/60" : "bg-muted-foreground/50"
                      )}
                      aria-hidden="true"
                    />
                    <div className="min-w-0 flex-1">
                      <p className="font-medium">
                        {entry.source === "audit"
                          ? t(`activity.actions.${entry.action}`)
                          : t(`activity.kinds.${entry.kind}`)}
                      </p>
                      <p className="truncate text-muted-foreground">
                        {entry.detail} · {since(entry.at)}
                      </p>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </Section>
        </div>
      </ScrollArea>

      <footer className="flex shrink-0 items-center gap-1 border-t px-3 py-2">
        <Button
          size="sm"
          variant="ghost"
          onClick={() => onPinToggle(memory.id, !memory.pinned)}
          data-testid="memory-inspector-pin"
        >
          {memory.pinned ? <PinOffIcon className="size-4" /> : <PinIcon className="size-4" />}
          {memory.pinned ? tPanel("unpin") : tPanel("pin")}
        </Button>
        {!editing ? (
          <Button size="sm" variant="ghost" onClick={beginEdit}>
            <PencilIcon className="size-4" />
            {tPanel("edit")}
          </Button>
        ) : null}
        <span className="flex-1" />
        {!invalidated ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setConfirmArchive(true)}
            data-testid="memory-inspector-archive"
          >
            <ArchiveIcon className="size-4" />
            {tPanel("archive")}
          </Button>
        ) : null}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="icon-sm" variant="ghost" aria-label={tPanel("moreActions")}>
              <MoreHorizontalIcon className="size-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              variant="destructive"
              onSelect={() => setConfirmDelete(true)}
              data-testid="memory-inspector-delete"
            >
              <Trash2Icon className="size-4" />
              {tPanel("deleteForever")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </footer>

      <ConfirmActionDialog
        open={confirmArchive}
        onOpenChange={setConfirmArchive}
        title={tPanel("archiveConfirm.title")}
        description={tPanel("archiveConfirm.description")}
        confirmLabel={tPanel("archiveConfirm.confirm")}
        cancelLabel={tPanel("archiveConfirm.cancel")}
        onConfirm={() => onArchive(memory.id)}
      />
      <ConfirmActionDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={t("deleteConfirm.title")}
        description={t("deleteConfirm.description")}
        confirmLabel={t("deleteConfirm.confirm")}
        cancelLabel={t("deleteConfirm.cancel")}
        tone="destructive"
        onConfirm={() => onDelete(memory.id)}
      />
    </div>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1.5">
      <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</h3>
      {children}
    </section>
  )
}

function FieldGrid({ children }: { children: React.ReactNode }) {
  return <dl className="grid grid-cols-2 gap-x-3 gap-y-1.5">{children}</dl>
}

function Field({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] text-muted-foreground">{label}</dt>
      <dd className={cn("truncate text-xs", mono && "font-mono")}>{value}</dd>
    </div>
  )
}

type TimelineEntry =
  | { key: string; source: "audit"; action: MemoryAuditEvent["action"]; detail: string; at: number }
  | { key: string; source: "evidence"; kind: MemoryEvidence["kind"]; detail: string; at: number }

/**
 * Evidence and audit rows interleaved, newest first. Both carry `createdAt`, so
 * one merged list reads as the memory's history instead of two counters.
 */
function buildTimeline(
  evidence: readonly MemoryEvidence[],
  auditEvents: readonly MemoryAuditEvent[]
): TimelineEntry[] {
  const entries: TimelineEntry[] = [
    ...auditEvents.map((event): TimelineEntry => ({
      key: `audit:${event.id}`,
      source: "audit",
      action: event.action,
      detail: event.reason,
      at: event.createdAt,
    })),
    ...evidence.map((row): TimelineEntry => ({
      key: `evidence:${row.id}`,
      source: "evidence",
      kind: row.kind,
      detail: row.sourceId,
      at: row.createdAt,
    })),
  ]
  return entries.sort((a, b) => b.at - a.at)
}
