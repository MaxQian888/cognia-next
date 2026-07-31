"use client"

/**
 * NativeLogViewer — read-back viewer over the desktop's on-disk log files
 * (`cognia-structured.log` / `cognia.log`) via the cross-platform
 * `logs_query` API. On desktop it reads the local files; on a paired phone
 * (Capacitor / web companion) it shows the **desktop's** logs remotely —
 * the mobile counterpart of "open the log directory".
 */

import { useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { FileTextIcon, RefreshCwIcon, ServerOffIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"
import { LEVEL_THEME } from "@cognia/logging/level-theme"
import type { LogLevel } from "@/types/logging"
import { useNativeLogQuery } from "@/hooks/logging/use-native-log-query"
import type { NativeLogQueryEntry } from "@/lib/native/native-logging"

const LEVEL_OPTIONS = ["all", "trace", "debug", "info", "warn", "error"] as const
const SEARCH_DEBOUNCE_MS = 300

function levelBadgeClass(level: string): string {
  const theme = LEVEL_THEME[level as LogLevel]
  return theme ? theme.badgeClass : LEVEL_THEME.info.badgeClass
}

function formatTimestamp(entry: NativeLogQueryEntry): string {
  if (entry.epochMs) {
    return new Date(entry.epochMs).toLocaleTimeString(undefined, { hour12: false })
  }
  return entry.timestamp
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

interface NativeLogViewerProps {
  className?: string
}

export function NativeLogViewer({ className }: NativeLogViewerProps) {
  const t = useTranslations("logging.nativeViewer")
  const { query, setQuery, result, loading, available, refresh } = useNativeLogQuery({
    refreshIntervalMs: 0,
  })

  const [search, setSearch] = useState(query.contains ?? "")
  useEffect(() => {
    const timer = setTimeout(() => {
      const trimmed = search.trim()
      setQuery({ contains: trimmed.length > 0 ? trimmed : undefined })
    }, SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [search, setQuery])

  const entries = useMemo(() => result?.entries ?? [], [result])

  if (available === false) {
    return (
      <div
        className={cn(
          "flex flex-col items-center justify-center gap-2 rounded-md border border-dashed p-8 text-center",
          className
        )}
      >
        <ServerOffIcon className="h-8 w-8 text-muted-foreground" aria-hidden />
        <p className="text-sm font-medium">{t("unavailableTitle")}</p>
        <p className="text-xs text-muted-foreground">{t("unavailableDescription")}</p>
        <Button size="sm" variant="outline" onClick={() => void refresh()}>
          <RefreshCwIcon className="h-3.5 w-3.5 mr-1.5" aria-hidden />
          {t("retry")}
        </Button>
      </div>
    )
  }

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={query.file ?? "structured"}
          onValueChange={(value) => setQuery({ file: value as "structured" | "plain" })}
        >
          <SelectTrigger className="w-[150px] h-8" aria-label={t("fileSelectLabel")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="structured">{t("fileStructured")}</SelectItem>
            <SelectItem value="plain">{t("filePlain")}</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={query.minLevel ?? "all"}
          onValueChange={(value) =>
            setQuery({
              minLevel:
                value === "all"
                  ? undefined
                  : (value as Exclude<(typeof LEVEL_OPTIONS)[number], "all">),
            })
          }
        >
          <SelectTrigger className="w-[120px] h-8" aria-label={t("levelSelectLabel")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {LEVEL_OPTIONS.map((level) => (
              <SelectItem key={level} value={level}>
                {level === "all" ? t("levelAll") : level}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder={t("searchPlaceholder")}
          aria-label={t("searchLabel")}
          className="h-8 w-[200px] flex-1 min-w-[140px]"
        />
        <Button
          size="sm"
          variant="outline"
          className="h-8"
          onClick={() => void refresh()}
          disabled={loading}
        >
          <RefreshCwIcon className={cn("h-3.5 w-3.5", loading && "animate-spin")} aria-hidden />
          <span className="sr-only">{t("refresh")}</span>
        </Button>
      </div>

      {result ? (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <FileTextIcon className="h-3.5 w-3.5" aria-hidden />
          <span className="truncate max-w-[280px]" title={result.path}>
            {result.path}
          </span>
          <span>{formatBytes(result.fileSize)}</span>
          {result.truncated ? (
            <Badge variant="outline" className="text-[10px]">
              {t("truncatedBadge")}
            </Badge>
          ) : null}
          <span>{t("entryCount", { count: entries.length })}</span>
        </div>
      ) : null}

      {loading && entries.length === 0 ? (
        <div className="flex flex-col gap-1.5" aria-hidden>
          <Skeleton className="h-6 w-full" />
          <Skeleton className="h-6 w-full" />
          <Skeleton className="h-6 w-2/3" />
        </div>
      ) : entries.length === 0 ? (
        <p className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
          {t("empty")}
        </p>
      ) : (
        <ul className="flex max-h-[420px] flex-col gap-px overflow-y-auto rounded-md border font-mono text-xs">
          {entries.map((entry, index) => (
            <li
              key={`${entry.timestamp}-${index}`}
              className="flex items-start gap-2 px-2 py-1 hover:bg-muted/50"
            >
              <span className="shrink-0 tabular-nums text-muted-foreground">
                {formatTimestamp(entry)}
              </span>
              <Badge
                variant="outline"
                className={cn(
                  "shrink-0 border-0 px-1 text-[10px] uppercase",
                  levelBadgeClass(entry.level)
                )}
              >
                {entry.level}
              </Badge>
              {entry.target ? (
                <span
                  className="shrink-0 max-w-[160px] truncate text-muted-foreground"
                  title={entry.target}
                >
                  {entry.target}
                </span>
              ) : null}
              <span className="min-w-0 whitespace-pre-wrap break-words">{entry.message}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
