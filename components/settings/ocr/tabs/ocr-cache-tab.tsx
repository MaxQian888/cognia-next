"use client"

/**
 * OCR Cache tab — global view of the Dexie `ocrResults` table.
 *
 * Lives inside the Auto-Router panel (alongside Defaults and Platform
 * Overrides). Reuses the existing cache helpers in `lib/db/ocr-results.ts`
 * and the Card / Table chrome from `search-cache-settings.tsx` +
 * `sessions-tab.tsx`. Per-row delete fires `deleteOcrCacheRow`; per-provider
 * bulk fires `clearOcrCacheForProvider`; the clear-all button fires
 * `clearOcrCache`.
 */

import * as React from "react"
import { useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { Eraser, Trash2 } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { toast } from "sonner"
import { getDb } from "@/lib/db/schema"
import {
  clearOcrCache,
  clearOcrCacheForProvider,
  deleteOcrCacheRow,
  ocrCacheStats,
  type OcrResultRow,
} from "@/lib/db/ocr-results"

const ALL_PROVIDERS = "__all__"

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

function formatRelative(now: number, then: number): string {
  const ms = now - then
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`
  if (ms < 3_600_000) return `${Math.floor(ms / 60_000)}m`
  if (ms < 86_400_000) return `${Math.floor(ms / 3_600_000)}h`
  return `${Math.floor(ms / 86_400_000)}d`
}

export function OcrCacheTab(): React.ReactElement {
  const t = useTranslations()
  const [providerFilter, setProviderFilter] = useState<string>(ALL_PROVIDERS)
  const [now, setNow] = useState<number>(() => Date.now())
  const [stats, setStats] = useState<{ count: number; bytes: number }>({ count: 0, bytes: 0 })

  // Tick the relative-time column once a minute so "5m ago" doesn't go stale.
  useEffect(() => {
    const handle = window.setInterval(() => setNow(Date.now()), 60_000)
    return () => window.clearInterval(handle)
  }, [])

  const rows = useLiveQuery(
    () => getDb().ocrResults.orderBy("createdAt").reverse().toArray(),
    []
  ) as OcrResultRow[] | undefined

  // Recompute aggregate stats every time the rows change. ocrCacheStats is the
  // canonical source — keep using it so future schema changes (e.g. a separate
  // bytes index) flow through transparently.
  useEffect(() => {
    let cancelled = false
    ocrCacheStats().then((s) => {
      if (!cancelled) setStats(s)
    })
    return () => {
      cancelled = true
    }
  }, [rows])

  const providerIds = useMemo(() => {
    if (!rows) return []
    return Array.from(new Set(rows.map((r) => r.providerId))).sort()
  }, [rows])

  const filteredRows = useMemo(() => {
    if (!rows) return []
    if (providerFilter === ALL_PROVIDERS) return rows
    return rows.filter((r) => r.providerId === providerFilter)
  }, [rows, providerFilter])

  const handleDeleteRow = async (id: string) => {
    try {
      await deleteOcrCacheRow(id)
      toast.success(t("ocr.cache.toastRowDeleted"))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  const handleClearProvider = async (providerId: string) => {
    try {
      const removed = await clearOcrCacheForProvider(providerId)
      toast.success(t("ocr.cache.toastProviderCleared", { count: removed }))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  const handleClearAll = async () => {
    try {
      const removed = await clearOcrCache()
      toast.success(t("ocr.cache.toastAllCleared", { count: removed }))
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    }
  }

  return (
    <Card data-testid="ocr-cache-tab">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <CardTitle className="text-sm">{t("ocr.cache.title")}</CardTitle>
            <CardDescription className="text-xs">{t("ocr.cache.description")}</CardDescription>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void handleClearAll()}
            disabled={stats.count === 0}
            data-testid="ocr-cache-clear-all"
          >
            <Eraser className="mr-1.5 h-3.5 w-3.5" />
            {t("ocr.cache.actions.clearAll")}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex items-center gap-2">
            <Badge variant="outline" data-testid="ocr-cache-total-count">
              {t("ocr.cache.totalCount", { count: stats.count })}
            </Badge>
            <Badge variant="outline" data-testid="ocr-cache-total-bytes">
              {formatBytes(stats.bytes)}
            </Badge>
          </div>
          <div className="ml-auto">
            <Select value={providerFilter} onValueChange={setProviderFilter}>
              <SelectTrigger
                className="h-8 w-[180px] text-xs"
                data-testid="ocr-cache-provider-filter"
              >
                <SelectValue placeholder={t("ocr.cache.filterAllProviders")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL_PROVIDERS}>{t("ocr.cache.filterAllProviders")}</SelectItem>
                {providerIds.map((id) => (
                  <SelectItem key={id} value={id}>
                    {id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>

        {providerFilter !== ALL_PROVIDERS && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void handleClearProvider(providerFilter)}
            data-testid="ocr-cache-clear-provider"
          >
            <Eraser className="mr-1.5 h-3.5 w-3.5" />
            {t("ocr.cache.actions.clearProvider", { provider: providerFilter })}
          </Button>
        )}

        {filteredRows.length === 0 ? (
          <p
            className="rounded border bg-muted/30 p-4 text-center text-xs italic text-muted-foreground"
            data-testid="ocr-cache-empty"
          >
            {t("ocr.cache.empty")}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("ocr.cache.tableHeaders.provider")}</TableHead>
                  <TableHead className="hidden md:table-cell">
                    {t("ocr.cache.tableHeaders.langs")}
                  </TableHead>
                  <TableHead className="text-right">
                    {t("ocr.cache.tableHeaders.sizeBytes")}
                  </TableHead>
                  <TableHead className="text-right">{t("ocr.cache.tableHeaders.age")}</TableHead>
                  <TableHead className="text-right">
                    {t("ocr.cache.tableHeaders.actions")}
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {filteredRows.map((r) => (
                  <TableRow key={r.id} data-testid={`ocr-cache-row-${r.id}`}>
                    <TableCell className="font-medium">{r.providerId}</TableCell>
                    <TableCell className="hidden md:table-cell text-xs text-muted-foreground">
                      {r.langs || "—"}
                    </TableCell>
                    <TableCell className="text-right text-xs">{formatBytes(r.bytesIn)}</TableCell>
                    <TableCell className="text-right text-xs">
                      {formatRelative(now, r.createdAt)}
                    </TableCell>
                    <TableCell className="text-right">
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="h-6 px-2"
                        onClick={() => void handleDeleteRow(r.id)}
                        aria-label={t("ocr.cache.actions.delete")}
                        data-testid={`ocr-cache-delete-${r.id}`}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
