"use client"

/**
 * The `/memory` Health tab: rule-based lint findings over the memory store
 * (`@cognia/memory/lint/memory-lint`). Report-only — every finding links to the
 * memory it is about, and any change happens in the inspector, through the
 * usual commands.
 */

import { useTranslations } from "next-intl"
import {
  ArrowUpRightIcon,
  CircleCheckIcon,
  InfoIcon,
  RefreshCwIcon,
  TriangleAlertIcon,
} from "lucide-react"

import type { Memory } from "@/types/memory/memory"
import type { MemoryLintReport } from "@/lib/memory/lint/run-memory-lint"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { ScrollArea } from "@/components/ui/scroll-area"
import { cn } from "@/lib/utils"

export interface MemoryHealthPanelProps {
  report: MemoryLintReport | undefined
  loading: boolean
  onRefresh: () => void
  resolveMemory: (id: string) => Memory | undefined
  onOpenMemory: (id: string) => void
}

export function MemoryHealthPanel({
  report,
  loading,
  onRefresh,
  resolveMemory,
  onOpenMemory,
}: MemoryHealthPanelProps) {
  const t = useTranslations("memory.health")
  const findings = report?.findings ?? []

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="memory-health-panel">
      <div className="flex shrink-0 flex-wrap items-start justify-between gap-2 border-b px-3 py-2">
        <div className="min-w-0 space-y-0.5">
          <h2 className="text-sm font-medium">{t("title")}</h2>
          <p className="text-xs text-muted-foreground">{t("description")}</p>
          {report ? (
            <p className="text-[11px] text-muted-foreground" data-testid="memory-health-meta">
              {t("scanned", { count: report.scanned })} ·{" "}
              {t(`contradictionCheck.${report.contradictionCheck}`)}
            </p>
          ) : null}
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={onRefresh}
          disabled={loading}
          data-testid="memory-health-refresh"
        >
          <RefreshCwIcon className={cn("size-4", loading && "motion-safe:animate-spin")} />
          {loading ? t("checking") : t("refresh")}
        </Button>
      </div>

      <ScrollArea className="min-h-0 flex-1">
        {report && findings.length === 0 ? (
          <div className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
            <CircleCheckIcon className="size-4" aria-hidden="true" />
            {t("empty")}
          </div>
        ) : (
          <ul className="flex flex-col divide-y" data-testid="memory-health-findings">
            {findings.map((finding, index) => {
              const Icon = finding.severity === "warning" ? TriangleAlertIcon : InfoIcon
              return (
                <li
                  key={`${finding.kind}:${finding.memoryIds.join(",")}:${index}`}
                  className="flex flex-col gap-1.5 px-3 py-2.5"
                  data-testid="memory-health-finding"
                  data-kind={finding.kind}
                >
                  <div className="flex items-center gap-1.5">
                    <Icon
                      className={cn(
                        "size-3.5 shrink-0",
                        finding.severity === "warning"
                          ? "text-amber-600 dark:text-amber-400"
                          : "text-muted-foreground"
                      )}
                      aria-hidden="true"
                    />
                    <span className="text-sm font-medium">{t(`kinds.${finding.kind}.title`)}</span>
                    <Badge variant="outline" className="h-5 px-1.5 text-[10px] font-normal">
                      {t(`severity.${finding.severity}`)}
                    </Badge>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {t(`kinds.${finding.kind}.description`, finding.metrics ?? {})}
                  </p>
                  <ul className="flex flex-col gap-1">
                    {finding.memoryIds.map((id) => {
                      const memory = resolveMemory(id)
                      return (
                        <li key={id} className="flex items-center gap-2 text-xs">
                          <span className="min-w-0 flex-1 truncate">
                            {memory?.text ?? t("gone")}
                          </span>
                          {memory ? (
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-6 shrink-0 px-1.5 text-xs"
                              onClick={() => onOpenMemory(id)}
                            >
                              <ArrowUpRightIcon className="size-3.5" />
                              {t("open")}
                            </Button>
                          ) : null}
                        </li>
                      )
                    })}
                  </ul>
                </li>
              )
            })}
          </ul>
        )}
      </ScrollArea>
    </div>
  )
}
