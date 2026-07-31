"use client"

// Viewer for one optical-compaction archive (ADR-0063). Opened from the
// compact-boundary marker when the "optical" strategy imaged the older turns.
// Loads the durable Dexie row (survives reload, unlike the in-memory undo
// snapshot) and shows the rendered frame(s), the before/after token comparison,
// the render shape, and — on demand — the original text that was imaged.

import { useState } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react"

import { getOpticalArchive } from "@/lib/db/optical-archives"
import { ImageBlock } from "@/components/chat/renderers/image-block"
import { MessageImageCollectionProvider } from "@/components/chat/renderers/message-image-collection"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

const compactNum = new Intl.NumberFormat("en-US", { notation: "compact" })

export function OpticalArchiveDialog({
  archiveId,
  open,
  onOpenChange,
}: {
  archiveId: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const t = useTranslations("chat.opticalArchive")
  const [revealed, setRevealed] = useState(false)
  const archive = useLiveQuery(
    () => (open && archiveId ? getOpticalArchive(archiveId) : undefined),
    [open, archiveId]
  )

  const savedPct =
    archive && archive.preTokens > 0
      ? Math.max(0, Math.round((1 - archive.postTokens / archive.preTokens) * 100))
      : 0
  const shape = archive?.shape as { font?: string; variant?: string; size?: number } | undefined

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[85vh] max-w-2xl overflow-y-auto"
        data-testid="optical-archive-dialog"
      >
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>
            {t("description", { count: archive?.frameCount ?? 0 })}
          </DialogDescription>
        </DialogHeader>

        {!archive ? (
          <p className="py-6 text-center text-sm text-muted-foreground">{t("notFound")}</p>
        ) : (
          <div className="space-y-4">
            <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm sm:grid-cols-3">
              <Stat label={t("tokens")}>
                {compactNum.format(archive.preTokens)} → {compactNum.format(archive.postTokens)}
                <span className="ml-1 text-emerald-600 dark:text-emerald-400">
                  ({t("saved", { pct: savedPct })})
                </span>
              </Stat>
              {shape && (
                <Stat label={t("shape")}>
                  {[shape.font, shape.variant, shape.size ? `${shape.size}px` : null]
                    .filter(Boolean)
                    .join(" · ")}
                </Stat>
              )}
              {typeof archive.coverage === "number" && (
                <Stat label={t("coverage")}>{Math.round(archive.coverage * 100)}%</Stat>
              )}
              {typeof archive.readability === "number" && (
                <Stat label={t("readability")}>{Math.round(archive.readability * 100)}%</Stat>
              )}
              {typeof archive.estImageTokens === "number" &&
                typeof archive.estTextTokens === "number" && (
                  <Stat label={t("estimate")}>
                    {compactNum.format(archive.estImageTokens)} /{" "}
                    {compactNum.format(archive.estTextTokens)}
                  </Stat>
                )}
            </dl>

            {/* An optical frame IS text rendered to pixels, so "can't zoom"
                means "can't read". Route through ImageBlock for the lightbox /
                zoom / download affordances instead of a bare <img>, and share
                one collection so the frames of a single compaction page as the
                continuous document they actually are. */}
            <MessageImageCollectionProvider>
              <div className="space-y-3">
                {archive.frames.map((frame, i) => (
                  <ImageBlock
                    key={i}
                    src={`data:image/png;base64,${frame.base64}`}
                    alt={t("frameAlt", { n: i + 1 })}
                    width={frame.width}
                    height={frame.height}
                    className="my-0 block w-full border border-border bg-white"
                  />
                ))}
              </div>
            </MessageImageCollectionProvider>

            {archive.originalText ? (
              <div>
                <button
                  type="button"
                  onClick={() => setRevealed((v) => !v)}
                  data-testid="optical-reveal-text"
                  className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                >
                  {revealed ? (
                    <ChevronDownIcon className="size-4" aria-hidden />
                  ) : (
                    <ChevronRightIcon className="size-4" aria-hidden />
                  )}
                  {revealed ? t("hideText") : t("revealText")}
                </button>
                {revealed && (
                  <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-muted p-3 text-xs">
                    {archive.originalText}
                  </pre>
                )}
              </div>
            ) : (
              <p className="text-xs text-muted-foreground">{t("noText")}</p>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}

function Stat({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="font-medium">{children}</dd>
    </div>
  )
}
