"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { PlayIcon } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { enqueue } from "@/lib/db/mobile-outbound-queue"
import { impact } from "@/lib/capacitor/haptics"

export interface TriggerButtonProps {
  workflowId: string
  workflowName: string
  /** Optional className applied to the button. */
  className?: string
  /** Optional override for the queue label (defaults to the workflow name). */
  queueLabel?: string
}

/**
 * Mobile workflow manual-trigger button (Wave 3.1).
 *
 * Enqueues a `workflow_trigger_manual` outbound job (the runner dispatches
 * via `transport.call` once the desktop is reachable). Surfaces a toast
 * with the i18n queued message and bumps a haptic.
 */
export function TriggerButton({
  workflowId,
  workflowName,
  className,
  queueLabel,
}: TriggerButtonProps) {
  const t = useTranslations("mobile.workflow")
  const [busy, setBusy] = useState(false)

  const onClick = async () => {
    if (busy) return
    setBusy(true)
    try {
      await enqueue({
        command: "workflow_trigger_manual",
        payload: { workflowId },
        label: queueLabel ?? workflowName,
      })
      void impact("light")
      toast.success(t("runQueued"))
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      toast.error(t("runFailed", { message }))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Button
      type="button"
      onClick={onClick}
      disabled={busy}
      size="sm"
      // Mobile touch target floor (iOS HIG 44px) — `min-h-11` wins over the
      // `size="sm"` height without changing the desktop visual weight.
      className={cn("min-h-11", className)}
      data-testid={`workflow-trigger-${workflowId}`}
    >
      <PlayIcon className="size-3.5" aria-hidden="true" />
      <span className="ml-1">{t("runButton")}</span>
    </Button>
  )
}
