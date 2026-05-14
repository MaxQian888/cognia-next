"use client"

import { useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"
import { listTwinSourcesByTwin, deleteTwinSource } from "@/lib/db/twin-sources"
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

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

export function TwinSourcesTab({ twinId }: { twinId: string }) {
  const t = useTranslations("twin.sources")
  const tCharts = useTranslations("twin.charts.status")
  const tFormat = useTranslations("twin.format")
  const [showUploader, setShowUploader] = useState(false)
  const sources = useLiveQuery(() => listTwinSourcesByTwin(twinId), [twinId], [])

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

      {sources.length === 0 ? (
        <Card className="p-6 text-center">
          <p className="text-muted-foreground text-sm">{t("emptyHint")}</p>
        </Card>
      ) : (
        <ul className="flex flex-col gap-2">
          {sources.map((source) => (
            <SourceRow
              key={source.id}
              source={source}
              t={t}
              statusLabel={(s) => tCharts(s as Exclude<TwinSourceStatus, never>)}
              formatLabel={(f) => tFormat(f)}
            />
          ))}
        </ul>
      )}
    </div>
  )
}

function SourceRow({
  source,
  t,
  statusLabel,
  formatLabel,
}: {
  source: TwinSource
  t: ReturnType<typeof useTranslations>
  statusLabel: (s: TwinSourceStatus) => string
  formatLabel: (f: TwinSource["format"]) => string
}) {
  return (
    <Card className="flex items-center justify-between gap-3 p-3">
      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium">{source.title}</span>
          <Badge variant={STATUS_VARIANT[source.status]} className="shrink-0">
            {statusLabel(source.status)}
          </Badge>
          <Badge variant="outline" className="shrink-0">
            {formatLabel(source.format)}
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
      <Button
        size="sm"
        variant="outline"
        onClick={() => {
          void deleteTwinSource(source.id)
        }}
      >
        {t("delete")}
      </Button>
    </Card>
  )
}
