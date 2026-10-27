"use client"

import { useTranslations } from "next-intl"
import { useEffect, useState } from "react"
import { useSandboxDesktopStream } from "@/hooks/automation/use-sandbox-desktop-stream"
import {
  useComputerUsePipStreamSlot,
  useComputerUsePipStreamTransport,
} from "@/lib/automation/computer-use-pip-resources"

/** A view-only PiP reuses the authenticated stream without mounting control UI. */
export function ComputerUseStreamPreview({
  connectionId,
  active,
  onReadyChange,
  hasFrame = false,
  priority = false,
}: {
  connectionId: string
  active: boolean
  onReadyChange?: (ready: boolean) => void
  hasFrame?: boolean
  priority?: boolean
}) {
  const t = useTranslations("automation.pictureInPicture")
  const allowed = useComputerUsePipStreamSlot(connectionId, active, priority)
  const transport = useComputerUsePipStreamTransport(allowed, connectionId)
  const { grant, status, attachFrame } = useSandboxDesktopStream(connectionId, allowed, transport)
  const [loadedUrl, setLoadedUrl] = useState<string | null>(null)
  const ready =
    allowed &&
    grant?.role === "viewer" &&
    (status === "open" || (status === "unmonitored" && loadedUrl === grant.url))
  useEffect(() => {
    onReadyChange?.(ready)
    return () => onReadyChange?.(false)
  }, [onReadyChange, ready])
  if (!grant || grant.role !== "viewer")
    return active && !hasFrame && (status === "error" || status === "unavailable") ? (
      <span
        role="status"
        className="absolute inset-0 flex items-center justify-center bg-black px-3 text-xs text-white/70"
      >
        {t("previewUnavailable")}
      </span>
    ) : null
  return (
    <div className="pointer-events-none absolute inset-0" aria-hidden>
      <iframe
        key={grant.url}
        ref={attachFrame}
        src={grant.url}
        onLoad={() => setLoadedUrl(grant.url)}
        title={t("streamTitle")}
        tabIndex={-1}
        sandbox="allow-scripts allow-same-origin"
        allow="autoplay"
        referrerPolicy="no-referrer"
        className={`absolute inset-0 size-full border-0 bg-black ${ready ? "opacity-100" : "opacity-0"}`}
      />
      {ready && (
        <span className="absolute left-2 top-2 flex items-center gap-1 rounded bg-black/70 px-1.5 py-0.5 text-[10px] text-white">
          <span className="size-1.5 rounded-full bg-emerald-400" />
          {t("live")}
        </span>
      )}
    </div>
  )
}
