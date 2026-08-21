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
 * group's expand-all/collapse-all in simplified mode) and uncontrolled use. In
 * the uncontrolled case `defaultOpen` seeds the initial state — the activity
 * group's standard/detailed path remounts its children with a fresh key to
 * apply it, the same convention the `<Tool>` cards use.
 */

import { memo, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import {
  CheckCircleIcon,
  ChevronRightIcon,
  CircleIcon,
  ClockIcon,
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
  XCircleIcon,
} from "lucide-react"
import type { LucideIcon } from "lucide-react"
import type { ToolUIPart } from "ai"

import { ToolDetailBody } from "@/components/chat/message-parts/tool-detail-body"
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
import { MotionStatusSwap, ReadingCollapse } from "@/components/chat/motion/motion-reveal"
import { ToolSemanticBadges } from "@/components/ai-elements/tool-semantic-badges"
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

const STATUS_GLYPH: Record<
  ToolUIPart["state"],
  { Icon: LucideIcon; className: string; key: string }
> = {
  "approval-requested": {
    Icon: ClockIcon,
    className: "text-yellow-600 dark:text-yellow-500",
    key: "awaitingApproval",
  },
  "approval-responded": {
    Icon: CheckCircleIcon,
    className: "text-blue-600 dark:text-blue-500",
    key: "responded",
  },
  "input-available": {
    Icon: ClockIcon,
    className: "animate-pulse text-muted-foreground",
    key: "running",
  },
  "input-streaming": { Icon: CircleIcon, className: "text-muted-foreground", key: "pending" },
  "output-available": {
    Icon: CheckCircleIcon,
    className: "text-green-600 dark:text-green-500",
    key: "completed",
  },
  "output-denied": {
    Icon: XCircleIcon,
    className: "text-orange-600 dark:text-orange-500",
    key: "denied",
  },
  "output-error": { Icon: XCircleIcon, className: "text-red-600 dark:text-red-500", key: "error" },
}

export interface ToolCallRowProps {
  part: ToolUIPart
  /** Controlled open state; omit for uncontrolled (internal) toggling. */
  expanded?: boolean
  onToggle?: () => void
  /** Seeds the uncontrolled open state at mount (read once, like `defaultOpen`). */
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
  const [internalOpen, setInternalOpen] = useState(defaultOpen ?? false)
  const controlled = expanded !== undefined
  const open = controlled ? expanded : internalOpen

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
  const glyph = STATUS_GLYPH[part.state]
  const statusLabel = t(`status.${glyph.key}`)

  const handleToggle = () => {
    if (controlled) onToggle?.()
    else setInternalOpen((v) => !v)
  }

  return (
    // Borderless, recessive row (Codex-style): the tool activity fades into the
    // background so the assistant's prose stands out. Expanding nests the full
    // input/output under a left rule instead of boxing it in a card.
    <div
      className="not-prose"
      data-testid={`tool-call-row-${summary.name}`}
      data-status={part.state}
    >
      <button
        type="button"
        onClick={handleToggle}
        aria-expanded={open}
        aria-label={t("rowAria", { name: displayName, status: statusLabel })}
        className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-sm text-muted-foreground transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60"
      >
        <ChevronRightIcon
          className={cn("size-3.5 shrink-0 opacity-60 transition-transform", open && "rotate-90")}
        />
        <Icon className="size-3.5 shrink-0" />
        <span className="font-medium text-foreground/80">{displayName}</span>
        {!providedTitle && summary.target ? (
          <span className="min-w-0 flex-1 truncate font-mono text-xs">{summary.target}</span>
        ) : (
          <span className="flex-1" />
        )}
        <ToolSemanticBadges readOnlyHint={readOnlyHint} />
        {result ? (
          <ToolResultChip descriptor={result} />
        ) : running ? (
          <RunningProgressChip lines={running.lines} />
        ) : null}
        <MotionStatusSwap swapKey={part.state} className="shrink-0">
          <glyph.Icon className={cn("size-3.5", glyph.className)} aria-hidden />
        </MotionStatusSwap>
        <span className="sr-only">{statusLabel}</span>
      </button>
      <ReadingCollapse open={open}>
        {/* ml aligns the left rule under the chevron (px-1.5 + half of size-3.5). */}
        <div className="ml-[13px] mb-1 space-y-3 border-l pl-3 pt-1 text-popover-foreground">
          <ToolDetailBody part={part} sessionId={sessionId} />
        </div>
      </ReadingCollapse>
    </div>
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
