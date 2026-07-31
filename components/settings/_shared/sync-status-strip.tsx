"use client"

// SyncStatusStrip — a compact, non-resident sync control.
//
// Replaces always-on "sync cards" (the resident bordered panels that
// permanently showed counts / last-synced even when nothing was happening).
// The strip is just a small trigger button plus a *transient* status line that
// appears only while syncing, on error, when the data is stale, and as a brief
// "synced" confirmation that auto-dismisses. When everything is fresh and idle
// it collapses to the button alone, so it no longer occupies the page.
//
// Purely presentational: the parent maps its domain state (a catalog hook, a
// WebDAV phase, …) onto a `phase` + `statusText`. Shared by the models.dev
// catalog sync (Settings → Providers) and the subscription WebDAV sync
// (Settings → Subscription) so the behaviour stays consistent.

import { useEffect, useRef, useState } from "react"
import { RefreshCw, Loader2, AlertCircle, CheckCircle2 } from "lucide-react"
import { Button } from "@/components/ui/button"

/** Lifecycle the strip can be in. `idle` renders the button only. */
export type SyncPhase = "idle" | "syncing" | "error" | "stale" | "success"

/** How long the brief post-sync "Synced ✓" confirmation stays up (ms). */
export const SYNC_SUCCESS_LINGER_MS = 3000

export interface SyncStatusStripProps {
  /** Button label in the idle/stale state, e.g. "Sync from models.dev". */
  label: string
  /** Button label while a sync is in flight. */
  syncingLabel: string
  /** Brief confirmation shown for ~3s right after a sync completes. */
  syncedLabel: string
  /** Current lifecycle phase derived by the parent from its domain state. */
  phase: SyncPhase
  /**
   * Transient detail shown next to the button for non-idle phases — progress
   * text while syncing, the error message on error, a "N days old" hint when
   * stale. Ignored in the idle/success states.
   */
  statusText?: string
  /**
   * Summary (counts, last-synced) surfaced as the button's hover title so the
   * information stays discoverable without occupying the page.
   */
  summary?: string
  /** Trigger a sync. */
  onSync: () => void
  /** Block the button (e.g. connection not ready). `syncing` always disables. */
  disabled?: boolean
  /** Optional test id forwarded to the root element. */
  "data-testid"?: string
}

/**
 * Detect the `syncing → idle` transition and show the success confirmation for
 * a short, self-clearing window. Returns whether the confirmation is showing.
 */
function useSuccessLinger(phase: SyncPhase): boolean {
  const [showSuccess, setShowSuccess] = useState(false)
  const prevPhase = useRef<SyncPhase>(phase)

  useEffect(() => {
    const prev = prevPhase.current
    prevPhase.current = phase
    // A sync that was in flight and resolved cleanly (back to idle) earns the
    // brief confirmation. An explicit `success` phase does the same.
    if ((prev === "syncing" && phase === "idle") || phase === "success") {
      setShowSuccess(true)
      const timer = setTimeout(() => setShowSuccess(false), SYNC_SUCCESS_LINGER_MS)
      return () => clearTimeout(timer)
    }
  }, [phase])

  // The confirmation only renders in a resting/success phase, so a new sync
  // (syncing/error/stale) hides any lingering "Synced" without an extra
  // setState in the effect body.
  return showSuccess && (phase === "idle" || phase === "success")
}

export function SyncStatusStrip({
  label,
  syncingLabel,
  syncedLabel,
  phase,
  statusText,
  summary,
  onSync,
  disabled,
  "data-testid": testId,
}: SyncStatusStripProps) {
  const showSuccess = useSuccessLinger(phase)
  const isSyncing = phase === "syncing"

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid={testId}>
      <Button
        size="sm"
        variant="outline"
        onClick={onSync}
        disabled={disabled || isSyncing}
        title={summary}
        className="shrink-0"
      >
        {isSyncing ? (
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        ) : (
          <RefreshCw className="mr-2 h-4 w-4" />
        )}
        {isSyncing ? syncingLabel : label}
      </Button>

      {/* Transient status — never shown in the resting idle state. */}
      {isSyncing && statusText && (
        <span className="text-xs text-muted-foreground" role="status">
          {statusText}
        </span>
      )}
      {phase === "error" && (
        <span className="flex items-center gap-1 text-xs text-destructive" role="status">
          <AlertCircle className="h-3.5 w-3.5" />
          {statusText}
        </span>
      )}
      {phase === "stale" && !isSyncing && statusText && (
        <span className="text-xs text-muted-foreground" role="status">
          {statusText}
        </span>
      )}
      {showSuccess && (
        <span className="flex items-center gap-1 text-xs text-emerald-600" role="status">
          <CheckCircle2 className="h-3.5 w-3.5" />
          {syncedLabel}
        </span>
      )}
    </div>
  )
}

export default SyncStatusStrip
