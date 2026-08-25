"use client"

import { useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  acceptBrowserAdjustment,
  previewBrowserAdjustment,
  revertBrowserAdjustment,
  type BrowserAdjustmentDraft,
} from "@/lib/browser/adjust"
import type { BrowserAdjustmentChange, BrowserAdjustmentFeedback } from "@/types/browser-developer"

export function BrowserAdjustControls({
  sessionId,
  browserSessionId,
  pageUrl,
  selector,
  onAccept,
}: {
  sessionId: string
  browserSessionId: string
  pageUrl: string
  selector: string
  onAccept(feedback: BrowserAdjustmentFeedback): void
}) {
  const t = useTranslations("browser.adjust")
  const previewId = useRef(`browser-adjust:${crypto.randomUUID()}`)
  const [draft, setDraft] = useState<BrowserAdjustmentDraft>({})
  const [changes, setChanges] = useState<BrowserAdjustmentChange[]>([])
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const id = previewId.current
    return () => {
      void revertBrowserAdjustment(id).catch(() => undefined)
    }
  }, [pageUrl, selector])

  /**
   * Every one of these drives an `embedEvaluate` round-trip that can reject —
   * the element went away, the page navigated, the lease moved. Without a
   * `catch` the rejection became an invisible unhandled promise and the UI
   * simply did nothing, which reads as a broken button.
   */
  const run = async (operation: () => Promise<void>) => {
    setBusy(true)
    try {
      await operation()
    } catch (cause) {
      toast.error(t("failed", { message: cause instanceof Error ? cause.message : String(cause) }))
    } finally {
      setBusy(false)
    }
  }

  const preview = () =>
    run(async () => {
      setChanges(await previewBrowserAdjustment({ previewId: previewId.current, selector, draft }))
    })

  const revert = () =>
    run(async () => {
      await revertBrowserAdjustment(previewId.current)
      setChanges([])
    })

  const accept = () =>
    run(async () => {
      onAccept(
        await acceptBrowserAdjustment({
          previewId: previewId.current,
          sessionId,
          browserSessionId,
          pageUrl,
          selector,
          changes,
        })
      )
      setChanges([])
    })

  // A field typed into and then cleared leaves its key behind with an empty
  // value, so counting keys kept Preview enabled with nothing to preview.
  const hasDraft = Object.values(draft).some((value) => value?.trim())

  return (
    <div className="mt-2 space-y-2 rounded-md border p-2" aria-label={t("label")}>
      <div className="grid grid-cols-2 gap-1.5">
        {(["font", "text", "spacing", "color"] as const).map((property) => (
          <Input
            key={property}
            value={draft[property] ?? ""}
            onChange={(event) =>
              setDraft((current) => ({ ...current, [property]: event.target.value }))
            }
            placeholder={t(property)}
            aria-label={t(property)}
            className="h-7 text-xs"
          />
        ))}
      </div>
      <div className="flex justify-end gap-1.5">
        <Button
          size="sm"
          variant="ghost"
          disabled={busy || changes.length === 0}
          onClick={() => void revert()}
        >
          {t("revert")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy || !hasDraft}
          onClick={() => void preview()}
        >
          {t("preview")}
        </Button>
        <Button size="sm" disabled={busy || changes.length === 0} onClick={() => void accept()}>
          {t("accept")}
        </Button>
      </div>
    </div>
  )
}
