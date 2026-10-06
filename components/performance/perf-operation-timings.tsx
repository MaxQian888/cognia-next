"use client"

import { useEffect, useId, useSyncExternalStore } from "react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { formatCount, formatMs } from "@/lib/perf/backend/format"
import { OPERATION_GROUPS, getOperationPerformanceRecorder } from "@/lib/perf/operation-performance"

const COUNTS = ["count", "errors", "cancelled", "inFlight", "samples"] as const
const DURATIONS = ["lastMs", "p50Ms", "p95Ms", "maxMs"] as const

/** Fixed operation summaries remain available after returning from another view. */
export function PerfOperationTimings() {
  const t = useTranslations("performance.operations")
  const id = useId()
  const recorder = getOperationPerformanceRecorder()
  const { settings, rows, dropped, persistenceError } = useSyncExternalStore(
    recorder.subscribe,
    recorder.getSnapshot,
    recorder.getServerSnapshot
  )
  useEffect(() => recorder.connect(), [recorder])
  const visible = rows.filter(
    (row) => settings.enabled && settings.groups[row.group] && (row.count > 0 || row.inFlight > 0)
  )

  return (
    <section className="min-w-0 rounded-lg border bg-background" aria-labelledby={`${id}-title`}>
      <header className="flex flex-wrap items-start justify-between gap-3 border-b p-4">
        <div>
          <h3 id={`${id}-title`} className="text-base font-medium">
            {t("title")}
          </h3>
          <p className="mt-1 max-w-prose text-xs text-muted-foreground">{t("description")}</p>
        </div>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => recorder.clear()}
          disabled={!rows.some((row) => row.count || row.inFlight) && !dropped}
        >
          {t("clear")}
        </Button>
      </header>
      <div className="space-y-4 p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <Label htmlFor={`${id}-enabled`}>{t("collection.label")}</Label>
            <p id={`${id}-hint`} className="mt-1 max-w-prose text-xs text-muted-foreground">
              {t("collection.description")}
            </p>
          </div>
          <Switch
            id={`${id}-enabled`}
            aria-describedby={`${id}-hint`}
            checked={settings.enabled}
            onCheckedChange={(enabled) => recorder.updateSettings({ enabled })}
          />
        </div>
        {persistenceError && (
          <p role="alert" className="text-sm text-destructive">
            {t("persistenceError")}
          </p>
        )}
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {OPERATION_GROUPS.map((group) => (
            <div key={group} className="min-w-0 rounded-md border p-3">
              <div className="flex items-center justify-between gap-3">
                <Label htmlFor={`${id}-${group}`}>{t(`groups.${group}.label`)}</Label>
                <Switch
                  id={`${id}-${group}`}
                  checked={settings.groups[group]}
                  disabled={!settings.enabled}
                  onCheckedChange={(enabled) =>
                    recorder.updateSettings({ groups: { [group]: enabled } })
                  }
                />
              </div>
              <p className="mt-2 text-xs text-muted-foreground">
                {t(`groups.${group}.description`)}
              </p>
            </div>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">{t("lifecycleHint")}</p>
        {dropped > 0 && (
          <p className="text-xs text-muted-foreground">{t("dropped", { count: dropped })}</p>
        )}
      </div>
      {visible.length ? (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{t("columns.name")}</TableHead>
              {[...COUNTS, ...DURATIONS].map((key) => (
                <TableHead key={key} className="text-right">
                  {t(`columns.${key}`)}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {visible.map((row) => (
              <TableRow key={row.name}>
                <TableCell className="min-w-44">
                  <p className="text-sm">{t(`names.${row.name}`)}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {t(`groups.${row.group}.label`)}
                  </p>
                </TableCell>
                {COUNTS.map((key) => (
                  <TableCell key={key} className="text-right font-mono tabular-nums">
                    {formatCount(row[key])}
                  </TableCell>
                ))}
                {DURATIONS.map((key) => (
                  <TableCell
                    key={key}
                    className="whitespace-nowrap text-right font-mono tabular-nums"
                  >
                    {row[key] === null ? t("unavailable") : formatMs(row[key])}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      ) : (
        <p className="px-4 pb-4 text-sm text-muted-foreground">
          {t(settings.enabled ? "empty" : "off")}
        </p>
      )}
      <p className="border-t p-4 text-xs text-muted-foreground">{t("statisticsHint")}</p>
    </section>
  )
}
