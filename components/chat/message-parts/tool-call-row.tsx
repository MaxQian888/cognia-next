"use client"

/**
 * Compact single-line representation of a tool call, used by the "simplified"
 * agent-flow display mode. Shows an icon + tool name + concise target + status
 * glyph on one row; clicking expands the full input/output inline (reusing the
 * standard `ToolBody`).
 *
 * Supports both controlled (`expanded` + `onToggle`, driven by the activity
 * group's expand-all/collapse-all) and uncontrolled (internal state) use.
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

import { ToolBody } from "@/components/ai-elements/tool"
import { summarizeToolCall, type ToolIconKey } from "@/lib/chat/tool-summary"
import { describeToolResult, type ToolResultDescriptor } from "@/lib/chat/tool-result-summary"
import { MotionCollapse, MotionStatusSwap } from "@/components/chat/motion/motion-reveal"
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
}

export const ToolCallRow = memo(function ToolCallRow({
  part,
  expanded,
  onToggle,
}: ToolCallRowProps) {
  const t = useTranslations("chat.agentFlow")
  const [internalOpen, setInternalOpen] = useState(false)
  const controlled = expanded !== undefined
  const open = controlled ? expanded : internalOpen

  // Both summarizers scan the tool input/output (describeToolResult splits the
  // full output into lines); memoize on the part identity — which the chat
  // store replaces per delta, the same assumption MessagePart's memo relies on —
  // so they don't re-run when an unrelated sibling row toggles or streams.
  const summary = useMemo(() => summarizeToolCall(part), [part])
  const result = useMemo(() => describeToolResult(part), [part])
  const Icon = ICON_MAP[summary.iconKey]
  const glyph = STATUS_GLYPH[part.state]
  const statusLabel = t(`status.${glyph.key}`)

  const handleToggle = () => {
    if (controlled) onToggle?.()
    else setInternalOpen((v) => !v)
  }

  return (
    <div
      className="not-prose rounded-md border bg-card"
      data-testid={`tool-call-row-${summary.name}`}
      data-status={part.state}
    >
      <button
        type="button"
        onClick={handleToggle}
        aria-expanded={open}
        aria-label={t("rowAria", { name: summary.name, status: statusLabel })}
        className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-sm transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60"
      >
        <ChevronRightIcon
          className={cn(
            "size-3.5 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90"
          )}
        />
        <Icon className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="font-medium">{summary.name}</span>
        {summary.target ? (
          <span className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
            {summary.target}
          </span>
        ) : (
          <span className="flex-1" />
        )}
        {result ? <ToolResultChip descriptor={result} /> : null}
        <MotionStatusSwap swapKey={part.state} className="shrink-0">
          <glyph.Icon className={cn("size-3.5", glyph.className)} aria-hidden />
        </MotionStatusSwap>
        <span className="sr-only">{statusLabel}</span>
      </button>
      <MotionCollapse open={open}>
        <div className="space-y-3 border-t px-3 py-2.5 text-popover-foreground">
          <ToolBody part={part} />
        </div>
      </MotionCollapse>
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
        "max-w-[40%] shrink-0 truncate font-mono text-[11px] tabular-nums",
        TONE_CLASS[descriptor.tone]
      )}
      data-testid="tool-result-chip"
      data-kind={descriptor.kind}
    >
      {label}
    </span>
  )
})
