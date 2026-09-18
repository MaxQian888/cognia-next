"use client"

/**
 * Shared primitives for the inline tool-call rows (`TerminalToolPart`,
 * `FileToolPart`) and the activity-group header: a single status dot, a
 * compact hover copy button, and the theme-matched expansion block that nests
 * under a row. Kept tiny on purpose — the row language is "status dot +
 * mono target + meta + chevron", and every consumer composes it the same way.
 */

import { memo, type ReactNode } from "react"
import { CheckIcon, ChevronRightIcon, CopyIcon } from "lucide-react"
import type { ToolUIPart } from "ai"

import { Button } from "@/components/ui/button"
import { ReadingCollapse } from "@/components/chat/motion/motion-reveal"
import { useCopy } from "@/hooks/ui"
import { cn } from "@/lib/utils"

/** Aggregate states the activity-group header can collapse a run into. */
export type ToolDotStatus =
  ToolUIPart["state"] | "running" | "pending" | "complete" | "error" | "warning" | "info"

const STATUS_DOT: Record<ToolDotStatus, { className: string; breathe?: boolean }> = {
  "input-streaming": { className: "bg-muted-foreground/50" },
  "input-available": { className: "bg-blue-500", breathe: true },
  "approval-requested": { className: "bg-yellow-600 dark:bg-yellow-500", breathe: true },
  "approval-responded": { className: "bg-blue-600 dark:bg-blue-500" },
  "output-available": { className: "bg-green-600 dark:bg-green-500" },
  "output-denied": { className: "bg-orange-600 dark:bg-orange-500" },
  "output-error": { className: "bg-red-600 dark:bg-red-500" },
  // Aggregate aliases (ToolActivityGroup folds a run into one status).
  running: { className: "bg-blue-500", breathe: true },
  error: { className: "bg-red-600 dark:bg-red-500" },
  pending: { className: "bg-muted-foreground/50" },
  complete: { className: "bg-green-600 dark:bg-green-500" },
  // Non-tool stream rows map their outcomes onto these aliases too: a hook
  // warning, an ungrounded claim, or a context injection is still one status
  // in the same dot language.
  warning: { className: "bg-amber-500" },
  info: { className: "bg-blue-500" },
}

/** The breathing status dot every tool row leads with. */
export const ToolStatusDot = memo(function ToolStatusDot({
  status,
  className,
}: {
  status: ToolDotStatus
  className?: string
}) {
  const dot = STATUS_DOT[status]
  return (
    <span
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        dot.className,
        dot.breathe && "animate-pulse",
        className
      )}
      aria-hidden
    />
  )
})

/** Icon button that copies `value`; shows a check briefly after a write. */
export const InlineCopyButton = memo(function InlineCopyButton({
  value,
  label,
  testId,
}: {
  value: string
  label: string
  testId?: string
}) {
  const { copy, copied } = useCopy()
  const Icon = copied ? CheckIcon : CopyIcon
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="size-6 text-muted-foreground hover:text-foreground"
      aria-label={label}
      title={label}
      data-testid={testId}
      onClick={(e) => {
        e.stopPropagation()
        void copy(value)
      }}
    >
      <Icon className="size-3" />
    </Button>
  )
})

/**
 * The shared row chrome every inline tool call composes — status dot + lead
 * (`$` prompt or coloured verb) + optional icon + mono target + badges + meta
 * + trailing chevron, with hover-revealed actions and the collapse that nests
 * the body under the row. `TerminalToolPart`, `FileToolPart` and
 * `StructuredToolPart` all render through this so the message stream keeps a
 * single row language and the variants can never drift.
 */
export function ToolRowShell({
  status,
  open = false,
  onToggle,
  ariaLabel,
  title,
  testId,
  toggleTestId,
  dataKind,
  dataStatus,
  className,
  lead,
  icon,
  target,
  badges,
  meta,
  actions,
  children,
}: {
  status: ToolDotStatus
  open?: boolean
  onToggle?: () => void
  ariaLabel: string
  /** Hover tooltip on the row — usually the untruncated target text. */
  title?: string
  testId: string
  /** Test id for the toggle button itself (defaults to `${testId}-toggle`). */
  toggleTestId?: string
  dataKind?: string
  /** Overrides `data-status` on the root when the raw domain status differs
      from the mapped dot status (e.g. subagent states). */
  dataStatus?: string
  /** Extra classes on the outermost wrapper (stream spacing like `my-2`). */
  className?: string
  /** The element right after the dot: `$` prompt or coloured verb label. */
  lead: ReactNode
  /** Icon between the lead and the target (file-type glyph, globe, …). */
  icon?: ReactNode
  /** The mono target; may wrap a `Shimmer` while the call runs. */
  target?: ReactNode
  badges?: ReactNode
  /** Right-aligned result/status meta text. */
  meta?: ReactNode
  /** Hover-revealed action buttons (copy / open / review). */
  actions?: ReactNode
  children?: ReactNode
}) {
  return (
    <div
      className={cn("group/trow not-prose", className)}
      data-testid={testId}
      data-kind={dataKind}
      data-status={dataStatus ?? status}
    >
      <div className="relative flex items-center gap-1 rounded-md px-1.5 py-1 transition-colors hover:bg-muted/50">
        {(() => {
          // No body → the row is a static status line: no chevron to expand
          // nothing, and no button semantics the click could never satisfy.
          const inner = (
            <>
              <ToolStatusDot status={status} />
              {lead}
              {icon}
              {target}
              {badges}
              {meta}
              {children != null ? (
                <ChevronRightIcon
                  className={cn(
                    "size-3.5 shrink-0 text-muted-foreground transition-transform",
                    open && "rotate-90"
                  )}
                  aria-hidden
                />
              ) : null}
            </>
          )
          return children != null ? (
            <button
              type="button"
              onClick={onToggle}
              aria-expanded={open}
              aria-label={ariaLabel}
              title={title}
              data-testid={toggleTestId ?? `${testId}-toggle`}
              className="flex min-w-0 flex-1 items-center gap-2 text-left focus-visible:outline-none"
            >
              {inner}
            </button>
          ) : (
            <div
              className="flex min-w-0 flex-1 items-center gap-2"
              aria-label={ariaLabel}
              title={title}
              data-testid={toggleTestId ?? `${testId}-toggle`}
            >
              {inner}
            </div>
          )
        })()}
        {actions ? (
          // Absolutely anchored left of the chevron so every row's ▸ keeps the
          // same right edge — in-flow actions used to push the chevron ~24px
          // left on rows that had them. The muted chip covers the meta text it
          // overlays only while hovered.
          <div className="absolute right-6 top-1/2 flex -translate-y-1/2 items-center gap-0.5 rounded-md bg-muted px-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover/trow:opacity-100">
            {actions}
          </div>
        ) : null}
      </div>
      {children != null ? (
        <ReadingCollapse open={open}>
          <div className="ml-[15px]">{children}</div>
        </ReadingCollapse>
      ) : null}
    </div>
  )
}

/**
 * The theme-matched block that nests under an expanded tool row: bordered,
 * left-railed, `bg-muted` surface (light *and* dark theme — the message stream
 * stays consistent instead of dropping a dark console into light chats).
 * Carries a slim uppercase header (label + optional copy affordance) above a
 * scrollable mono body.
 */
export function ToolRowBlock({
  label,
  copyValue,
  copyLabel,
  testId,
  streaming,
  mono = true,
  error = false,
  children,
}: {
  label: string
  /** When set, the header shows an inline copy button for this payload. */
  copyValue?: string
  copyLabel?: string
  testId?: string
  streaming?: boolean
  /** Set false for prose content (diffs still keep their own mono styling). */
  mono?: boolean
  /** Tints the label red — the generic body uses it for the error payload. */
  error?: boolean
  children: React.ReactNode
}) {
  return (
    <div
      className={cn(
        "mt-0.5 mb-1 overflow-hidden rounded-md border border-l-2 bg-muted/40 text-xs",
        error && "border-destructive/40",
        mono && "font-mono"
      )}
      data-testid={testId}
      data-streaming={streaming || undefined}
    >
      <div
        className={cn(
          "flex items-center justify-between gap-2 border-b px-2 py-0.5 text-[10px] uppercase tracking-wide",
          error ? "text-destructive" : "text-muted-foreground"
        )}
      >
        <span className="min-w-0 truncate">{label}</span>
        {copyValue ? (
          <InlineCopyButton
            value={copyValue}
            label={copyLabel ?? label}
            testId={testId ? `${testId}-copy` : undefined}
          />
        ) : null}
      </div>
      <div className="max-h-56 overflow-auto">{children}</div>
    </div>
  )
}
