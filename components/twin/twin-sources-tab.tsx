"use client"

import { memo, useEffect, useMemo, useRef, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { useSearchParams } from "next/navigation"
import { useTranslations } from "next-intl"
import { motion, useReducedMotion } from "motion/react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { cn } from "@/lib/utils"
import { StatusBadge } from "@/components/status-badge"
import { listTwinSourcesByTwin, deleteTwinSource } from "@/lib/db/twin-sources"
import { enqueueIngestJob } from "@/lib/twin/ingest"
import type { TwinSource, TwinSourceStatus } from "@/types/twin"
import { TwinSourceUploader } from "./twin-source-uploader"

const STATUS_VARIANT: Record<
  TwinSourceStatus,
  "default" | "secondary" | "destructive" | "outline"
> = {
  pending: "outline",
  parsing: "secondary",
  parsed: "default",
  failed: "destructive",
  deleted: "outline",
}

/** Chip order for the status filter row; "all" is prepended in the UI. */
const FILTERABLE_STATUSES: TwinSourceStatus[] = ["pending", "parsing", "parsed", "failed"]

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

export function TwinSourcesTab({ twinId }: { twinId: string }) {
  const t = useTranslations("twin.sources")
  const tStatus = useTranslations("twin.charts.status")
  const prefersReducedMotion = useReducedMotion()
  const [showUploader, setShowUploader] = useState(false)
  const [queuing, setQueuing] = useState(false)
  const [statusFilter, setStatusFilter] = useState<TwinSourceStatus | "all">("all")
  const [pendingDelete, setPendingDelete] = useState<TwinSource | null>(null)
  const sources = useLiveQuery(() => listTwinSourcesByTwin(twinId), [twinId], [])
  const pendingSources = useMemo(() => sources.filter((s) => s.status === "pending"), [sources])

  const statusCounts = useMemo(() => {
    const counts = new Map<TwinSourceStatus, number>()
    for (const s of sources) counts.set(s.status, (counts.get(s.status) ?? 0) + 1)
    return counts
  }, [sources])

  const filtered = useMemo(
    () => (statusFilter === "all" ? sources : sources.filter((s) => s.status === statusFilter)),
    [sources, statusFilter]
  )

  // Bridge upload → ingest: uploaded sources land as `pending` and otherwise
  // sit there until the user discovers the Jobs tab. Surface a one-click CTA so
  // the next step is obvious without auto-spending embedding tokens.
  const queuePendingIngest = async () => {
    if (pendingSources.length === 0) return
    setQueuing(true)
    try {
      await enqueueIngestJob({ twinId, sourceIds: pendingSources.map((s) => s.id) })
    } finally {
      setQueuing(false)
    }
  }

  const confirmDelete = async () => {
    if (!pendingDelete) return
    await deleteTwinSource(pendingDelete.id)
    setPendingDelete(null)
  }

  // Deep-link from the chat SourcesPart "View source" link: when the URL
  // carries ?sourceId=…, scroll the matching row into view and apply a
  // 2s ring highlight so the user can spot it instantly.
  const searchParams = useSearchParams()
  const highlightedSourceId = searchParams?.get("sourceId") ?? null
  const rowRefs = useRef<Map<string, HTMLLIElement>>(new Map())
  const [activeHighlight, setActiveHighlight] = useState<string | null>(null)

  useEffect(() => {
    if (!highlightedSourceId) return
    // Wait one tick for the row to mount (sources may still be loading).
    const tickHandle = window.setTimeout(() => {
      const el = rowRefs.current.get(highlightedSourceId)
      if (!el) return
      el.scrollIntoView({ behavior: "smooth", block: "center" })
      setActiveHighlight(highlightedSourceId)
    }, 60)
    return () => window.clearTimeout(tickHandle)
  }, [highlightedSourceId, sources.length])

  useEffect(() => {
    if (!activeHighlight) return
    const handle = window.setTimeout(() => setActiveHighlight(null), 2000)
    return () => window.clearTimeout(handle)
  }, [activeHighlight])

  const visibleFilters = FILTERABLE_STATUSES.filter((s) => (statusCounts.get(s) ?? 0) > 0)

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-medium">{t("headerCount", { count: sources.length })}</h2>
        <Button size="sm" onClick={() => setShowUploader((v) => !v)}>
          {showUploader ? t("cancelAdd") : t("addSource")}
        </Button>
      </div>

      {showUploader ? (
        <TwinSourceUploader twinId={twinId} onUploaded={() => setShowUploader(false)} />
      ) : null}

      {pendingSources.length > 0 ? (
        <Card className="flex flex-wrap items-center justify-between gap-2 border-primary/40 bg-primary/5 p-3">
          <p className="text-sm">{t("pendingIngestHint", { count: pendingSources.length })}</p>
          <Button
            size="sm"
            onClick={() => void queuePendingIngest()}
            disabled={queuing}
            data-testid="twin-sources-queue-ingest"
          >
            {queuing ? t("pendingIngestBusy") : t("pendingIngestCta")}
          </Button>
        </Card>
      ) : null}

      {visibleFilters.length > 1 ? (
        <div
          className="flex flex-wrap items-center gap-1.5"
          role="group"
          aria-label={t("filterLabel")}
          data-testid="twin-sources-filter"
        >
          <Button
            size="sm"
            variant={statusFilter === "all" ? "secondary" : "ghost"}
            className="h-7 px-2 text-xs"
            onClick={() => setStatusFilter("all")}
            aria-pressed={statusFilter === "all"}
          >
            {t("filterAll")} ({sources.length})
          </Button>
          {visibleFilters.map((status) => (
            <Button
              key={status}
              size="sm"
              variant={statusFilter === status ? "secondary" : "ghost"}
              className="h-7 px-2 text-xs"
              onClick={() => setStatusFilter((prev) => (prev === status ? "all" : status))}
              aria-pressed={statusFilter === status}
              data-testid={`twin-sources-filter-${status}`}
            >
              {tStatus(status)} ({statusCounts.get(status) ?? 0})
            </Button>
          ))}
        </div>
      ) : null}

      {sources.length === 0 ? (
        <Card className="p-6 text-center">
          <p className="text-muted-foreground text-sm">{t("emptyHint")}</p>
        </Card>
      ) : filtered.length === 0 ? (
        <Card className="p-6 text-center">
          <p className="text-muted-foreground text-sm">{t("filterEmpty")}</p>
        </Card>
      ) : (
        <ul className="flex flex-col gap-2">
          {filtered.map((source, index) => (
            <motion.li
              key={source.id}
              ref={(el) => {
                if (el) rowRefs.current.set(source.id, el)
                else rowRefs.current.delete(source.id)
              }}
              initial={prefersReducedMotion ? false : { opacity: 0, y: 4 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{
                duration: 0.15,
                ease: "easeOut",
                delay: prefersReducedMotion ? 0 : Math.min(index * 0.03, 0.15),
              }}
              className={cn(
                "list-none rounded-md transition-shadow",
                activeHighlight === source.id && "ring-2 ring-primary"
              )}
              data-testid={`twin-source-${source.id}-row`}
            >
              <SourceRow source={source} onDeleteRequest={setPendingDelete} />
            </motion.li>
          ))}
        </ul>
      )}

      <AlertDialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDelete(null)
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("deleteConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("deleteConfirmDescription", { title: pendingDelete?.title ?? "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("deleteConfirmCancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void confirmDelete()}
              data-testid="twin-sources-delete-confirm"
            >
              {t("deleteConfirmAction")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

/**
 * A single source row. Memoised — live-query refreshes replace only changed
 * rows' objects, so unrelated rows skip re-rendering.
 */
const SourceRow = memo(function SourceRow({
  source,
  onDeleteRequest,
}: {
  source: TwinSource
  onDeleteRequest: (source: TwinSource) => void
}) {
  const t = useTranslations("twin.sources")
  const tFormat = useTranslations("twin.format")
  return (
    <Card className="flex items-center justify-between gap-3 p-3">
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate font-medium">{source.title}</span>
          <StatusBadge
            value={source.status}
            labelNamespace="twin.charts.status"
            variantMap={STATUS_VARIANT}
            pulse={source.status === "parsing"}
            className="shrink-0"
            data-testid={`twin-source-${source.id}-status`}
          />
          <Badge variant="outline" className="shrink-0">
            {tFormat(source.format)}
          </Badge>
        </div>
        <div className="text-muted-foreground flex flex-wrap items-center gap-2 text-xs">
          <span>{formatBytes(source.bytes)}</span>
          <span>·</span>
          <span>{t("chunks", { count: source.chunkCount })}</span>
          <span>·</span>
          <span>{t("imported", { when: new Date(source.importedAt).toLocaleString() })}</span>
          {source.errorMessage ? (
            <>
              <span>·</span>
              <span className="text-destructive truncate">
                {t("errorPrefix")} {source.errorMessage}
              </span>
            </>
          ) : null}
        </div>
      </div>
      <Button size="sm" variant="outline" onClick={() => onDeleteRequest(source)}>
        {t("delete")}
      </Button>
    </Card>
  )
})
