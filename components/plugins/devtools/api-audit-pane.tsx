"use client"

/**
 * Every call a plugin makes into the host, with the permission verdict.
 *
 * `recordPluginApiAudit` has measured each `ctx.*` call since the governed
 * context landed, and the only consumer was the trace bridge in
 * `lib/plugin/observability/plugin-api-spans.ts`, which forwards a sampled
 * subset to `/logs`. A plugin author debugging a permission problem had to
 * leave DevTools, open Traces, and hope their call was one of the sampled
 * ones. This reads the same ring directly, unsampled.
 *
 * Metadata only. `recordPluginApiAudit` never accepts arguments or return
 * values, so there is nothing here to leak.
 */

import { useCallback, useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { NetworkIcon, Trash2Icon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { PluginEmptyState } from "@/components/plugins/_shared/plugin-empty-state"
import { Surface } from "@/components/surface/surface"
import {
  clearPluginApiAuditEvents,
  getRecentPluginApiAuditEvents,
  subscribePluginApiAudit,
  type PluginApiAuditEvent,
} from "@/lib/plugin/contracts/interface-catalog"
import { shouldTracePluginApiCall } from "@/lib/plugin/observability/plugin-api-spans"
import { cn } from "@/lib/utils"

export const ALL_FILTER = "all"

export type ApiAuditOutcome = PluginApiAuditEvent["outcome"]
export const API_AUDIT_OUTCOMES: ApiAuditOutcome[] = ["allowed", "denied", "error"]

export interface ApiAuditFilters {
  pluginId: string
  outcome: string
  tracedOnly: boolean
}

/** Pure, so the filter rules can be pinned without driving two Radix selects. */
export function filterApiAuditEvents(
  events: readonly PluginApiAuditEvent[],
  filters: ApiAuditFilters
): PluginApiAuditEvent[] {
  return events.filter((event) => {
    if (filters.pluginId !== ALL_FILTER && event.pluginId !== filters.pluginId) return false
    if (filters.outcome !== ALL_FILTER && event.outcome !== filters.outcome) return false
    return !filters.tracedOnly || shouldTracePluginApiCall(event)
  })
}

/** Pure. */
export function summarizeApiAudit(events: readonly PluginApiAuditEvent[]): {
  allowed: number
  denied: number
  errored: number
} {
  let allowed = 0
  let denied = 0
  let errored = 0
  for (const event of events) {
    if (event.outcome === "allowed") allowed += 1
    else if (event.outcome === "denied") denied += 1
    else errored += 1
  }
  return { allowed, denied, errored }
}

/**
 * The ring is module state that `recordPluginApiAudit` appends to and
 * `clearPluginApiAuditEvents` empties. Only the append path notifies, and it
 * notifies with an event rather than a snapshot, so this keeps its own copy
 * and re-reads on each notification. Clearing updates the copy directly:
 * making `clearPluginApiAuditEvents` notify would mean inventing an audit
 * event that never happened.
 */
function useApiAuditEvents(): {
  events: readonly PluginApiAuditEvent[]
  clear: () => void
} {
  const [events, setEvents] = useState<readonly PluginApiAuditEvent[]>(() =>
    getRecentPluginApiAuditEvents()
  )
  useEffect(() => subscribePluginApiAudit(() => setEvents(getRecentPluginApiAuditEvents())), [])
  const clear = useCallback(() => {
    clearPluginApiAuditEvents()
    setEvents([])
  }, [])
  return { events, clear }
}

const OUTCOME_VARIANT: Record<ApiAuditOutcome, "secondary" | "outline" | "destructive"> = {
  allowed: "secondary",
  denied: "outline",
  error: "destructive",
}

export function ApiAuditPane({ className }: { className?: string }) {
  const t = useTranslations("plugins.devtools.apiAudit")
  const { events, clear } = useApiAuditEvents()
  const [pluginId, setPluginId] = useState<string>(ALL_FILTER)
  const [outcome, setOutcome] = useState<string>(ALL_FILTER)
  const [tracedOnly, setTracedOnly] = useState(false)

  const pluginIds = useMemo(
    () => [...new Set(events.map((event) => event.pluginId))].sort(),
    [events]
  )
  const filtered = useMemo(
    () => filterApiAuditEvents(events, { pluginId, outcome, tracedOnly }),
    [events, pluginId, outcome, tracedOnly]
  )
  const summary = useMemo(() => summarizeApiAudit(filtered), [filtered])

  return (
    <Card className={cn("space-y-3 p-4", className)} data-testid="api-audit-pane">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <Surface
            layer="raised"
            className="flex size-9 shrink-0 items-center justify-center rounded-lg border "
          >
            <NetworkIcon className="size-4 text-muted-foreground" aria-hidden="true" />
          </Surface>
          <div className="min-w-0 space-y-1">
            <h3 className="truncate text-sm font-semibold tracking-tight">{t("title")}</h3>
            <p className="text-xs text-muted-foreground">{t("description")}</p>
          </div>
        </div>
        <Button
          size="sm"
          variant="ghost"
          disabled={events.length === 0}
          onClick={() => {
            clear()
            setPluginId(ALL_FILTER)
          }}
          data-testid="api-audit-clear"
        >
          <Trash2Icon className="mr-1 size-3.5" />
          {t("clear")}
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Select value={pluginId} onValueChange={setPluginId}>
          <SelectTrigger className="h-8 w-48 text-xs" aria-label={t("filterPlugin")}>
            <SelectValue placeholder={t("filterPlugin")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_FILTER}>{t("filterPluginAll")}</SelectItem>
            {pluginIds.map((id) => (
              <SelectItem key={id} value={id}>
                {id}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Select value={outcome} onValueChange={setOutcome}>
          <SelectTrigger className="h-8 w-40 text-xs" aria-label={t("filterOutcome")}>
            <SelectValue placeholder={t("filterOutcome")} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_FILTER}>{t("filterOutcomeAll")}</SelectItem>
            {API_AUDIT_OUTCOMES.map((value) => (
              <SelectItem key={value} value={value}>
                {t(`outcome.${value}` as never)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="flex items-center gap-2" title={t("tracedHint")}>
          <Switch
            id="api-audit-traced-only"
            checked={tracedOnly}
            onCheckedChange={setTracedOnly}
            aria-label={t("tracedOnly")}
          />
          <Label htmlFor="api-audit-traced-only" className="text-xs text-muted-foreground">
            {t("tracedOnly")}
          </Label>
        </div>
        <span
          className="ml-auto text-xs tabular-nums text-muted-foreground"
          data-testid="api-audit-summary"
        >
          {t("summary", summary)}
        </span>
      </div>

      {filtered.length === 0 ? (
        <PluginEmptyState
          icon={<NetworkIcon className="size-5" />}
          hint={t("empty")}
          className="min-h-24 gap-2 bg-muted/15 p-4 md:p-4 [&_[data-slot=empty-header]]:gap-1.5 [&_[data-slot=empty-icon]]:mb-0 [&_[data-slot=empty-title]]:text-base"
          dataTestId="api-audit-empty"
        />
      ) : (
        <ScrollArea className="max-h-[45vh]">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("colMethod")}</TableHead>
                <TableHead>{t("colPlugin")}</TableHead>
                <TableHead>{t("colRuntime")}</TableHead>
                <TableHead className="w-24">{t("colOutcome")}</TableHead>
                <TableHead className="text-right">{t("colDuration")}</TableHead>
                <TableHead className="hidden md:table-cell">{t("colData")}</TableHead>
                <TableHead>{t("colError")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {/*
                The ring carries no id or timestamp, so rows are keyed by their
                position in it. Newest first: the call you just made is the one
                you are looking for.
              */}
              {filtered
                .map((event, index) => ({ event, index }))
                .reverse()
                .map(({ event, index }) => (
                  <TableRow
                    key={`${event.pluginId}-${event.methodId}-${index}`}
                    data-outcome={event.outcome}
                  >
                    <TableCell className="font-mono text-[11px]">{event.methodId}</TableCell>
                    <TableCell className="text-xs">{event.pluginId}</TableCell>
                    <TableCell className="text-xs">{event.runtime}</TableCell>
                    <TableCell>
                      <Badge variant={OUTCOME_VARIANT[event.outcome]} className="text-[10px]">
                        {t(`outcome.${event.outcome}` as never)}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-right text-xs tabular-nums">
                      {t("durationMs", { ms: Math.round(event.durationMs) })}
                    </TableCell>
                    <TableCell className="hidden text-xs md:table-cell">
                      {event.dataClassification}
                    </TableCell>
                    <TableCell className="max-w-40 truncate text-[10px] text-destructive">
                      {event.errorCode ?? ""}
                    </TableCell>
                  </TableRow>
                ))}
            </TableBody>
          </Table>
        </ScrollArea>
      )}
    </Card>
  )
}
