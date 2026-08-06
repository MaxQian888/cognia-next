"use client"

/**
 * Compact log-stream panel for the Context Workbench.
 *
 * Displays a live-streamed log list with severity filter, optimized for the
 * workbench's constrained width. For the full logging experience (grouped traces,
 * detailed entries, stats), use `/logging`.
 */

import { useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import {
  ActivityIcon,
  AlertTriangleIcon,
  ExternalLinkIcon,
  InfoIcon,
  XCircleIcon,
} from "lucide-react"
import Link from "next/link"
import type { LogLevel } from "@/types/logging"
import { useLogStream } from "@/hooks/logging/use-log-stream"
import { cn } from "@/lib/utils"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Empty, EmptyMedia, EmptyTitle, EmptyDescription } from "@/components/ui/empty"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

type FilterLevel = LogLevel | "all"

const LEVEL_COLORS: Record<LogLevel, string> = {
  error: "text-destructive",
  warn: "text-yellow-600 dark:text-yellow-500",
  info: "text-blue-600 dark:text-blue-400",
  debug: "text-muted-foreground",
  trace: "text-muted-foreground/60",
}

const LEVEL_ICONS: Record<LogLevel, React.ComponentType<{ className?: string }>> = {
  error: XCircleIcon,
  warn: AlertTriangleIcon,
  info: InfoIcon,
  debug: ActivityIcon,
  trace: ActivityIcon,
}

export function LogsWorkbenchPanel() {
  const t = useTranslations("contextWorkbench.logsPanel")
  const [level, setLevel] = useState<FilterLevel>("info")

  const { logs, isLoading } = useLogStream({
    autoRefresh: true,
    refreshInterval: 3000,
    maxLogs: 200,
    level,
  })

  const errorCount = useMemo(() => logs.filter((log) => log.level === "error").length, [logs])

  return (
    <div className="flex h-full flex-col">
      {/* Header controls */}
      <div className="flex shrink-0 items-center justify-between border-b px-3 py-2">
        <span className="text-xs text-muted-foreground">
          {t("count", { count: logs.length })}
          {errorCount > 0 && (
            <Badge variant="destructive" className="ml-2 h-4 px-1 text-[10px]">
              {errorCount}
            </Badge>
          )}
        </span>
        <Select value={level} onValueChange={(v) => setLevel(v as FilterLevel)}>
          <SelectTrigger className="h-7 w-[90px] text-xs" aria-label={t("filterLabel")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("levels.all")}</SelectItem>
            <SelectItem value="error">{t("levels.error")}</SelectItem>
            <SelectItem value="warn">{t("levels.warn")}</SelectItem>
            <SelectItem value="info">{t("levels.info")}</SelectItem>
            <SelectItem value="debug">{t("levels.debug")}</SelectItem>
            <SelectItem value="trace">{t("levels.trace")}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Log list */}
      <ScrollArea className="flex-1">
        {isLoading ? (
          <div className="flex h-32 items-center justify-center">
            <span className="text-xs text-muted-foreground">{t("loading")}</span>
          </div>
        ) : logs.length === 0 ? (
          <Empty className="h-32 rounded-none">
            <EmptyMedia variant="icon">
              <ActivityIcon />
            </EmptyMedia>
            <EmptyTitle className="text-sm">{t("emptyTitle")}</EmptyTitle>
            <EmptyDescription className="text-xs">{t("emptyDescription")}</EmptyDescription>
          </Empty>
        ) : (
          <div className="divide-y">
            {logs.map((log) => {
              const Icon = LEVEL_ICONS[log.level] ?? ActivityIcon
              return (
                <div
                  key={log.id}
                  className="flex items-start gap-1.5 px-3 py-1.5"
                  data-testid={`log-entry-${log.id}`}
                >
                  <Icon className={cn("mt-0.5 size-3 shrink-0", LEVEL_COLORS[log.level])} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-xs">{log.message}</p>
                    <p className="truncate text-[10px] text-muted-foreground">
                      {log.module}
                      {" · "}
                      {new Date(log.timestamp).toLocaleTimeString()}
                    </p>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </ScrollArea>

      {/* Footer link to full logging page */}
      <div className="shrink-0 border-t p-2">
        <Button variant="ghost" size="sm" className="w-full text-xs" asChild>
          <Link href="/logging">
            <ExternalLinkIcon className="mr-1.5 size-3" />
            {t("openFullPage")}
          </Link>
        </Button>
      </div>
    </div>
  )
}
