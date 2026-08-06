"use client"

import { useEffect, useRef, useState } from "react"
import { useTranslations } from "next-intl"
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

  const preview = async () => {
    setBusy(true)
    try {
      setChanges(await previewBrowserAdjustment({ previewId: previewId.current, selector, draft }))
    } finally {
      setBusy(false)
    }
  }
  const revert = async () => {
    setBusy(true)
    try {
      await revertBrowserAdjustment(previewId.current)
      setChanges([])
    } finally {
      setBusy(false)
    }
  }
  const accept = async () => {
    setBusy(true)
    try {
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
    } finally {
      setBusy(false)
    }
  }

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
          disabled={busy || Object.keys(draft).length === 0}
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
