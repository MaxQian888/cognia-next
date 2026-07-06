"use client"

/**
 * Capture confirm bubble (OpenWiki-style): shows the pending clipboard capture
 * with a countdown; Save persists + enriches, Dismiss (or timeout) discards.
 * Rendered by {@link CaptureMount}; driven by the capture store.
 *
 * The inner card is keyed by the candidate fingerprint so each new pending
 * capture remounts a fresh countdown (no setState-in-effect resets).
 */

import { useCallback, useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { ClipboardCheckIcon, LinkIcon, XIcon } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { useCaptureStore } from "@/stores/capture/capture-store"
import { persistCapture } from "@/lib/capture/capture-manager"
import { buildEnrichDeps } from "@/lib/capture/enrich"
import type { CaptureCandidate } from "@/types/capture"

export interface CaptureBubbleProps {
  /** Seconds before auto-dismiss. */
  timeoutSec?: number
}

export function CaptureBubble({ timeoutSec = 8 }: CaptureBubbleProps) {
  const pending = useCaptureStore((s) => s.pending)
  const clear = useCaptureStore((s) => s.clear)
  if (!pending) return null
  return (
    <CaptureBubbleCard
      key={pending.fingerprint}
      candidate={pending}
      timeoutSec={timeoutSec}
      onClose={clear}
    />
  )
}

function CaptureBubbleCard({
  candidate,
  timeoutSec,
  onClose,
}: {
  candidate: CaptureCandidate
  timeoutSec: number
  onClose: () => void
}) {
  const t = useTranslations("capture")
  const [remaining, setRemaining] = useState(timeoutSec)
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)

  const onSave = useCallback(async () => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    onClose()
    try {
      const item = await persistCapture(candidate, { deps: buildEnrichDeps() })
      toast.success(item ? t("toast.saved") : t("toast.duplicate"))
    } catch (err) {
      toast.error(t("toast.failed", { message: err instanceof Error ? err.message : String(err) }))
    } finally {
      busyRef.current = false
      setBusy(false)
    }
  }, [candidate, onClose, t])

  // Countdown → auto-dismiss. setState happens only inside the interval
  // callback (not the effect body).
  useEffect(() => {
    const started = Date.now()
    const interval = setInterval(() => {
      const left = timeoutSec - Math.floor((Date.now() - started) / 1000)
      setRemaining(left)
      if (left <= 0) {
        clearInterval(interval)
        onClose()
      }
    }, 250)
    return () => clearInterval(interval)
  }, [timeoutSec, onClose])

  const preview = candidate.kind === "url" ? candidate.sourceUrl : candidate.text
  return (
    <div
      role="dialog"
      aria-label={t("bubbleAria")}
      className="fixed bottom-4 right-4 z-50 w-80 rounded-lg border bg-background p-3 shadow-lg"
      data-testid="capture-bubble"
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-xs font-medium">
          {candidate.kind === "url" ? (
            <LinkIcon className="h-3.5 w-3.5" />
          ) : (
            <ClipboardCheckIcon className="h-3.5 w-3.5" />
          )}
          {t(`kind.${candidate.kind}`)}
          {candidate.sourceApp && (
            <span className="text-muted-foreground">· {candidate.sourceApp}</span>
          )}
        </span>
        <button
          onClick={onClose}
          aria-label={t("close")}
          className="text-muted-foreground hover:text-foreground"
        >
          <XIcon className="h-3.5 w-3.5" />
        </button>
      </div>
      <p className="mb-2 line-clamp-3 break-words text-xs text-muted-foreground">{preview}</p>
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-muted-foreground">
          {t("countdown", { seconds: Math.max(0, remaining) })}
        </span>
        <div className="flex gap-1.5">
          <Button size="sm" variant="ghost" onClick={onClose} disabled={busy}>
            {t("dismiss")}
          </Button>
          <Button size="sm" onClick={() => void onSave()} disabled={busy}>
            {t("save")}
          </Button>
        </div>
      </div>
    </div>
  )
}
