"use client"

/**
 * Compact single-line representation of a tool call, used by the "simplified"
 * agent-flow display mode and by every sub-agent tree. Shows an icon + tool
 * name + concise target + status glyph on one row; clicking expands the exact
 * same body a standard-mode card shows, via the shared `ToolDetailBody`. The
 * row is the *collapsed* affordance — once the user asks for the detail, an
 * image must render as an image, a failed call must show its parsed trace, and
 * an A2UI surface must stay interactive.
 *
 * Supports both controlled (`expanded` + `onToggle`, driven by the activity
 * group's expand-all/collapse-all in every mode) and uncontrolled use. In
 * the uncontrolled case `defaultOpen` follows display-mode changes until the
 * user toggles the row. Activity groups control rows in every mode without
 * remounting their content.
 */

import { memo, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import {
  FileIcon,
  FilePlusIcon,
  FilesIcon,
  FolderIcon,
  GlobeIcon,
  ListChecksIcon,
  NotebookIcon,
  PencilIcon,
  SearchIcon,
  TerminalIcon,
  WrenchIcon,
} from "lucide-react"
import type { LucideIcon } from "lucide-react"
import type { ToolUIPart } from "ai"

import { ToolDetailBody } from "@/components/chat/message-parts/tool-detail-body"
import { ToolRowShell } from "@/components/chat/message-parts/tool-row"
import {
  humanizeToolName,
  resolveProvidedToolTitle,
  summarizeToolCall,
  type ToolIconKey,
} from "@/lib/chat/tool-summary"
import {
  describeRunningProgress,
  describeToolResult,
  type ToolResultDescriptor,
} from "@/lib/chat/tool-result-summary"
import { ToolSemanticBadges } from "@/components/chat/message-parts/tool-semantic-badges"
import { cn } from "@/lib/utils"

const ICON_MAP: Record<ToolIconKey, LucideIcon> = {
  read: FileIcon,
  write: FilePlusIcon,
  edit: PencilIcon,
  search: SearchIcon,
  glob: FilesIcon,
  terminal: TerminalIcon,
  web: GlobeIcon,
  folder: FolderIcon,
  notebook: NotebookIcon,
  task: ListChecksIcon,
  generic: WrenchIcon,
}

// The dot carries the state colour now (same STATUS_DOT map every tool row
// uses); the accessible label still comes from the per-state key.
const STATUS_KEY: Record<ToolUIPart["state"], string> = {
  "approval-requested": "awaitingApproval",
  "approval-responded": "responded",
  "input-available": "running",
  "input-streaming": "pending",
  "output-available": "completed",
  "output-denied": "denied",
  "output-error": "error",
}

export interface ToolCallRowProps {
  part: ToolUIPart
  /** Controlled open state; omit for uncontrolled (internal) toggling. */
  expanded?: boolean
  onToggle?: () => void
  /** Default for an untouched row; manual toggles override later changes. */
  defaultOpen?: boolean
  /** Owning chat session — threaded to the detail body's structured cards. */
  sessionId?: string
}

export const ToolCallRow = memo(function ToolCallRow({
  part,
  expanded,
  onToggle,
  defaultOpen,
  sessionId,
}: ToolCallRowProps) {
  const t = useTranslations("chat.agentFlow")
  const [internalOpen, setInternalOpen] = useState<boolean | null>(null)
  const controlled = expanded !== undefined
  const open = controlled ? expanded : (internalOpen ?? defaultOpen ?? false)

  // Both summarizers scan the tool input/output (describeToolResult splits the
  // full output into lines); memoize on the part identity — which the chat
  // store replaces per delta, the same assumption MessagePart's memo relies on —
  // so they don't re-run when an unrelated sibling row toggles or streams.
  const summary = useMemo(() => summarizeToolCall(part), [part])
  const providedTitle = resolveProvidedToolTitle(part)
  const displayName = providedTitle || humanizeToolName(summary.name)
  const readOnlyHint = (part as ToolUIPart & { toolMetadata?: { readOnlyHint?: boolean | null } })
    .toolMetadata?.readOnlyHint
  const result = useMemo(() => describeToolResult(part), [part])
  // Live output size while the tool is still running (Bash streams stdout);
  // null for tools that don't stream, leaving just the pulsing status glyph.
  const running = useMemo(() => describeRunningProgress(part), [part])
  const Icon = ICON_MAP[summary.iconKey]
  const statusLabel = t(`status.${STATUS_KEY[part.state]}`)

  const handleToggle = () => {
    if (controlled) onToggle?.()
    else setInternalOpen(!open)
  }

  return (
    // Same `ToolRowShell` grammar as the standard-mode tool parts: status dot +
    // name + icon + mono target + meta + trailing chevron, body nested under a
    // left rule. The status glyph that used to sit at the right edge is the
    // dot's job now.
    <ToolRowShell
      status={part.state}
      open={open}
      onToggle={handleToggle}
      ariaLabel={t("rowAria", { name: displayName, status: statusLabel })}
      testId={`tool-call-row-${summary.name}`}
      lead={<span className="shrink-0 text-xs font-medium text-foreground/80">{displayName}</span>}
      icon={<Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />}
      target={
        !providedTitle && summary.target ? (
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
            {summary.target}
          </span>
        ) : (
          <span className="flex-1" />
        )
      }
      badges={<ToolSemanticBadges readOnlyHint={readOnlyHint} />}
      meta={
        <>
          {result ? (
            <ToolResultChip descriptor={result} />
          ) : running ? (
            <RunningProgressChip lines={running.lines} />
          ) : null}
          <span
            className={
              part.state === "approval-requested" || part.state === "output-denied"
                ? "shrink-0 text-[11px] text-amber-600"
                : "sr-only"
            }
          >
            {statusLabel}
          </span>
        </>
      }
    >
      <div className="mb-1 space-y-3 border-l pl-3 pt-1 text-popover-foreground">
        <ToolDetailBody part={part} sessionId={sessionId} />
      </div>
    </ToolRowShell>
  )
})

const TONE_CLASS: Record<ToolResultDescriptor["tone"], string> = {
  neutral: "text-muted-foreground",
  success: "text-green-600 dark:text-green-500",
  error: "text-red-600 dark:text-red-500",
}

/** Translated result summary chip — "12 matches" / "+5 −2" / first error line. */
const ToolResultChip = memo(function ToolResultChip({
  descriptor,
}: {
  descriptor: ToolResultDescriptor
}) {
  const t = useTranslations("chat.agentFlow")
  let label: string
  switch (descriptor.kind) {
    case "diff":
      label = t("result.diff", { added: descriptor.added, removed: descriptor.removed })
      break
    case "matches":
      label = t("result.matches", { count: descriptor.count })
      break
    case "files":
      label = t("result.files", { count: descriptor.count })
      break
    case "entries":
      label = t("result.entries", { count: descriptor.count })
      break
    case "lines":
      label = t("result.lines", { count: descriptor.count })
      break
    case "error":
      label = descriptor.preview
      break
  }
  return (
    <span
      className={cn(
        "max-w-[40%] shrink-0 truncate rounded bg-muted/40 px-1 py-0.5 font-mono text-[11px] tabular-nums",
        TONE_CLASS[descriptor.tone]
      )}
      data-testid="tool-result-chip"
      data-kind={descriptor.kind}
    >
      {label}
    </span>
  )
})

/** Live "N lines…" chip shown while a tool streams output (Bash stdout). */
const RunningProgressChip = memo(function RunningProgressChip({ lines }: { lines: number }) {
  const t = useTranslations("chat.agentFlow")
  return (
    <span
      className="shrink-0 animate-pulse truncate rounded bg-muted/40 px-1 py-0.5 font-mono text-[11px] tabular-nums text-muted-foreground"
      data-testid="tool-running-chip"
    >
      {t("progress.streaming", { count: lines })}
    </span>
  )
})
