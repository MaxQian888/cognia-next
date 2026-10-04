"use client"

/**
 * NativeLogViewer — read-back viewer over the desktop's on-disk log files
 * (`cognia-structured.log` / `cognia.log`) via the cross-platform
 * `logs_query` API. On desktop it reads the local files; on a paired phone
 * (Capacitor / web companion) it shows the **desktop's** logs remotely —
 * the mobile counterpart of "open the log directory".
 *
 * "Unavailable" and "failed" are two states. Unavailable (plain web, an
 * unpaired phone) replaces the viewer with an explanation, because there is
 * nothing to query. A failed query — a locked file, a desktop that timed out —
 * keeps the toolbar, so the user can pick the other file or retry, and shows
 * the error above whatever the last good read returned. Both used to render
 * as "unavailable — pair with a desktop first", on a desktop.
 */

import { useEffect, useMemo, useState } from "react"
import { useFormatter, useTranslations } from "next-intl"
import { AlertCircleIcon, FileTextIcon, RefreshCwIcon, ServerOffIcon } from "lucide-react"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Skeleton } from "@/components/ui/skeleton"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { cn } from "@/lib/utils"
import { LEVEL_THEME } from "@cognia/logging/level-theme"
import type { LogLevel } from "@/types/logging"
import { useNativeLogQuery } from "@/hooks/logging/use-native-log-query"
import type { NativeLogQueryEntry } from "@/lib/native/native-logging"

const LEVEL_OPTIONS = ["all", "trace", "debug", "info", "warn", "error"] as const
const SEARCH_DEBOUNCE_MS = 300
const KNOWN_LEVELS = new Set<string>(["trace", "debug", "info", "warn", "error", "fatal"])

function levelBadgeClass(level: string): string {
  const theme = LEVEL_THEME[level as LogLevel]
  return theme ? theme.badgeClass : LEVEL_THEME.info.badgeClass
}

type Formatter = ReturnType<typeof useFormatter>

function formatTimestamp(entry: NativeLogQueryEntry, format: Formatter): string {
  if (entry.epochMs) {
    return format.dateTime(new Date(entry.epochMs), {
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    })
  }
  return entry.timestamp
}

/** File size in the app locale's digits and unit names (`1.5 KB`, `1.5 kB`, `1.5 KB`…). */
export function formatFileSize(size: number, format: Formatter): string {
  if (size < 1024) return format.number(size, { style: "unit", unit: "byte", unitDisplay: "short" })
  if (size < 1024 * 1024) {
    return format.number(size / 1024, {
      style: "unit",
      unit: "kilobyte",
      unitDisplay: "short",
      maximumFractionDigits: 1,
    })
  }
  return format.number(size / (1024 * 1024), {
    style: "unit",
    unit: "megabyte",
    unitDisplay: "short",
    maximumFractionDigits: 1,
  })
}

interface NativeLogViewerProps {
  className?: string
}

export function NativeLogViewer({ className }: NativeLogViewerProps) {
  const t = useTranslations("logging.nativeViewer")
  const tLogging = useTranslations("logging")
  const format = useFormatter()
  const { query, setQuery, result, loading, available, error, refresh } = useNativeLogQuery({
    refreshIntervalMs: 0,
  })
  // Level names in the user's language; a level the reader does not know
  // (a future tracing level) is shown as written in the file.
  const levelLabel = (level: string) =>
    KNOWN_LEVELS.has(level) ? tLogging(`levels.${level as LogLevel}`) : level

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
      <Empty
        className={cn(
          "flex flex-col items-center justify-center gap-2 border-y border-dashed p-8 text-center",
          className
        )}
      >
        <EmptyMedia variant="icon">
          <ServerOffIcon className="size-8 text-muted-foreground" aria-hidden />
        </EmptyMedia>
        <EmptyHeader>
          <EmptyTitle className="text-sm">{t("unavailableTitle")}</EmptyTitle>
          <EmptyDescription className="text-xs">{t("unavailableDescription")}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button size="sm" variant="outline" onClick={() => void refresh()}>
            <RefreshCwIcon className="mr-1.5 size-3.5" aria-hidden />
            {t("retry")}
          </Button>
        </EmptyContent>
      </Empty>
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
            <SelectGroup>
              <SelectItem value="structured">{t("fileStructured")}</SelectItem>
              <SelectItem value="plain">{t("filePlain")}</SelectItem>
            </SelectGroup>
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
            <SelectGroup>
              {LEVEL_OPTIONS.map((level) => (
                <SelectItem key={level} value={level}>
                  {level === "all" ? t("levelAll") : levelLabel(level)}
                </SelectItem>
              ))}
            </SelectGroup>
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

      {error ? (
        <Alert variant="destructive" data-testid="native-log-viewer-error">
          <AlertCircleIcon aria-hidden />
          <AlertTitle>{t("errorTitle")}</AlertTitle>
          <AlertDescription className="flex flex-wrap items-center gap-2">
            <span className="min-w-0 break-words">{error}</span>
            <Button size="sm" variant="outline" className="h-7" onClick={() => void refresh()}>
              {t("retry")}
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}

      {result ? (
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <FileTextIcon className="h-3.5 w-3.5" aria-hidden />
          <span className="truncate max-w-[280px]" title={result.path}>
            {result.path}
          </span>
          <span>{formatFileSize(result.fileSize, format)}</span>
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
      ) : entries.length === 0 && error ? null : entries.length === 0 ? (
        <Empty className="border-y border-dashed p-6">
          <EmptyHeader>
            <EmptyDescription>{t("empty")}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ul className="flex max-h-[420px] flex-col gap-px overflow-y-auto border-y font-mono text-xs">
          {entries.map((entry, index) => (
            <li
              key={`${entry.timestamp}-${index}`}
              className="flex items-start gap-2 px-2 py-1 hover:bg-muted/50"
            >
              <span className="shrink-0 tabular-nums text-muted-foreground">
                {formatTimestamp(entry, format)}
              </span>
              <Badge
                variant="outline"
                className={cn(
                  "shrink-0 border-0 px-1 text-[10px] uppercase",
                  levelBadgeClass(entry.level)
                )}
              >
                {levelLabel(entry.level)}
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
