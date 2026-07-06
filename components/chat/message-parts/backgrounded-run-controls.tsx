"use client"

// gap10 — shared action cluster for a backgrounded/abortable subagent run.
// Previously the chat transcript card (icon-only abort) and the desktop Job
// Center (labeled collect + cancel) hand-rolled their own controls, drifting in
// look and behavior. This presentational component unifies the actions; it is
// namespace-agnostic — every label/aria string and test id is passed in by the
// caller, so it can sit in both surfaces without owning their i18n.

import { memo, type MouseEvent } from "react"
import { BanIcon, DownloadIcon, XCircleIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export interface BackgroundedRunControlsProps {
  /** Whether the run is still running (gates the abort/cancel action). */
  isRunning: boolean
  /** "icon" = compact ghost icon (chat card); "labeled" = text buttons (Job Center). */
  variant: "icon" | "labeled"
  /** Abort/cancel handler. Omit to hide the abort action entirely. */
  onAbort?: (e: MouseEvent) => void
  /** Collect handler (labeled variant only). Omit to hide collect. */
  onCollect?: () => void
  /** Disabled/pending flags. */
  aborting?: boolean
  collecting?: boolean
  // Caller-resolved strings (namespace-agnostic).
  abortAria?: string
  /** Cancel/abort button text (labeled variant). */
  abortLabel?: string
  collectLabel?: string
  collectAria?: string
  // Stable test ids — callers pass their existing ones.
  abortTestId?: string
  collectTestId?: string
  className?: string
}

export const BackgroundedRunControls = memo(function BackgroundedRunControls({
  isRunning,
  variant,
  onAbort,
  onCollect,
  aborting,
  collecting,
  abortAria,
  abortLabel,
  collectLabel,
  collectAria,
  abortTestId,
  collectTestId,
  className,
}: BackgroundedRunControlsProps) {
  const showAbort = isRunning && !!onAbort

  if (variant === "icon") {
    if (!showAbort) return null
    return (
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className={cn("size-6 shrink-0 text-muted-foreground hover:text-destructive", className)}
        aria-label={abortAria}
        data-testid={abortTestId}
        disabled={aborting}
        onClick={onAbort}
      >
        <BanIcon className="size-3.5" />
      </Button>
    )
  }

  return (
    <div className={cn("flex shrink-0 items-center gap-1", className)}>
      {onCollect ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onCollect}
          disabled={collecting}
          data-testid={collectTestId}
          aria-label={collectAria}
        >
          <DownloadIcon data-icon="inline-start" />
          {collectLabel}
        </Button>
      ) : null}
      {showAbort ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={onAbort}
          disabled={aborting}
          data-testid={abortTestId}
          aria-label={abortAria}
        >
          <XCircleIcon data-icon="inline-start" />
          {abortLabel}
        </Button>
      ) : null}
    </div>
  )
})
