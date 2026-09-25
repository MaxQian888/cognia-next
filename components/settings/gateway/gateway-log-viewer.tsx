"use client"

/**
 * Gateway request-log viewer (desktop only).
 *
 * Reads the durable `gatewayRequestLog` Dexie table (fed by `GatewayProvider`
 * from the `gateway://request-log` event) via a live query, with outcome +
 * model + key filters, usage summary tiles, paging, export and a confirmed
 * clear — the newapi "Logs" page equivalent.
 *
 * Every row also carries how it was routed — strategy, distribution, the
 * deployment chosen, the planner's latency, the fallback reason and the full
 * attempt chain of the failover walk. All of it was persisted and none of it
 * rendered, so a request that succeeded on its third candidate looked exactly
 * like one that succeeded on its first. It now sits on the expandable detail
 * row next to `error`, `route`, `remoteIp` and `stream`.
 *
 * The table sheds columns as the pane narrows (container queries on
 * `@container/gateway-pane`, not the viewport); whatever is hidden reappears
 * in the detail row, so no field is unreachable at any width. Cost comes from
 * `estimateCallCostUsd` — the same estimator the routed workflow nodes price
 * with, not a second implementation.
 */

import { useEffect, useMemo, useState } from "react"
import { useFormatter, useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import {
  ChevronRightIcon,
  DownloadIcon,
  Loader2Icon,
  ScrollTextIcon,
  Trash2Icon,
} from "lucide-react"
import { toast } from "sonner"

import { estimateCallCostUsd } from "@cognia/provider-core/providers/model-pricing"
import { MotionCollapse, MotionReveal } from "@/components/chat/motion/motion-reveal"
import { SettingsEmptyState } from "@/components/settings/common/settings-section"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Item, ItemContent, ItemDescription, ItemGroup, ItemTitle } from "@/components/ui/item"
import {
  Select,
  SelectContent,
  SelectGroup,
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
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { cn } from "@/lib/utils"
import {
  clearGatewayRequestLog,
  GATEWAY_REQUEST_LOG_CAP,
  listGatewayRequestLog,
  summarizeGatewayUsage,
  type GatewayRequestLogFilter,
} from "@/lib/db/gateway-request-log"
import {
  downloadGatewayRequestLog,
  type GatewayRequestLogExportFormat,
} from "@/lib/gateway/request-log-export"
import { gatewayListKeys } from "@/lib/tauri/gateway"
import type { GatewayApiKeyRedacted, GatewayRequestLogRow } from "@/types/gateway"

import { GatewayPanelSection } from "./shared/panel-section"

type Outcome = "all" | "ok" | "errors"

const ALL_KEYS = "all"

/** Stable fallback while the live query is pending, so memoised work keys on it. */
const NO_ROWS: GatewayRequestLogRow[] = []

/** Rows fetched per page; "load more" extends the window by this much. */
export const LOG_PAGE_SIZE = 100

/**
 * Column visibility by pane width. Anything hidden here is repeated in the
 * detail row under the inverse class, so each field shows exactly once.
 */
const COLUMN_FROM_XL = "hidden @xl/gateway-pane:table-cell"
const COLUMN_FROM_2XL = "hidden @2xl/gateway-pane:table-cell"
const DETAIL_BELOW_XL = "@xl/gateway-pane:hidden"
const DETAIL_BELOW_2XL = "@2xl/gateway-pane:hidden"

function rowCostUsd(row: GatewayRequestLogRow): number | undefined {
  if (!row.providerId || !row.model) return undefined
  return estimateCallCostUsd({
    providerId: row.providerId,
    modelId: row.model,
    inputTokens: row.inputTokens ?? 0,
    outputTokens: row.outputTokens ?? 0,
  })
}

export function GatewayLogViewer() {
  const t = useTranslations("settings.gateway")
  const format = useFormatter()
  const [outcome, setOutcome] = useState<Outcome>("all")
  const [model, setModel] = useState("")
  const [keyFilter, setKeyFilter] = useState(ALL_KEYS)
  const [limit, setLimit] = useState(LOG_PAGE_SIZE)
  const [keys, setKeys] = useState<GatewayApiKeyRedacted[]>([])
  const [expanded, setExpanded] = useState<string | null>(null)
  const [confirmClear, setConfirmClear] = useState(false)
  const [clearing, setClearing] = useState(false)

  useEffect(() => {
    // Key id → name map for the log's Key column + filter dropdown.
    gatewayListKeys()
      .then(setKeys)
      .catch(() => {})
  }, [])

  const keyName = (id: string | null): string => {
    if (!id) return "—"
    return keys.find((k) => k.id === id)?.name ?? id.slice(0, 8)
  }

  const rows =
    useLiveQuery(() => {
      const filter: GatewayRequestLogFilter = { limit }
      if (outcome !== "all") filter.outcome = outcome
      if (model.trim()) filter.model = model.trim()
      if (keyFilter !== ALL_KEYS) filter.keyId = keyFilter
      return listGatewayRequestLog(filter)
    }, [outcome, model, keyFilter, limit]) ?? NO_ROWS

  const summary = summarizeGatewayUsage(rows)
  const costs = useMemo(() => new Map(rows.map((row) => [row.id, rowCostUsd(row)])), [rows])
  const pricedCosts = [...costs.values()].filter((cost): cost is number => cost !== undefined)
  const totalCost = pricedCosts.length > 0 ? pricedCosts.reduce((a, b) => a + b, 0) : undefined
  const canLoadMore = rows.length >= limit && limit < GATEWAY_REQUEST_LOG_CAP

  // "Arrived while you were watching" — anything logged after the panel opened.
  // Derived from the row's own timestamp rather than by diffing renders, so a
  // filter change (which re-orders the whole table) animates nothing, and
  // opening the panel does not slide a hundred historical rows in at once.
  const [openedAt] = useState(() => Date.now())

  const formatUsd = (value: number) =>
    format.number(value, {
      style: "currency",
      currency: "USD",
      minimumFractionDigits: 4,
      maximumFractionDigits: 4,
    })

  const onClear = async () => {
    setClearing(true)
    try {
      await clearGatewayRequestLog()
      setConfirmClear(false)
      setExpanded(null)
      toast.success(t("logCleared"))
    } catch (e) {
      // It used to swallow this and report "cleared" regardless.
      toast.error(e instanceof Error ? e.message : t("logClearFailed"))
    } finally {
      setClearing(false)
    }
  }

  const onExport = (exportFormat: GatewayRequestLogExportFormat) => {
    try {
      downloadGatewayRequestLog(rows, exportFormat)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : t("logExportFailed"))
    }
  }

  return (
    <GatewayPanelSection
      icon={<ScrollTextIcon className="size-4" />}
      title={t("logHeading")}
      description={t("logHelp")}
      action={
        <div className="flex flex-wrap gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="outline" disabled={rows.length === 0}>
                <DownloadIcon className="size-3.5" aria-hidden />
                {t("logExport")}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => onExport("csv")}>
                {t("logExportCsv")}
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => onExport("json")}>
                {t("logExportJson")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Button
            size="sm"
            variant={confirmClear ? "secondary" : "ghost"}
            disabled={clearing}
            onClick={() => setConfirmClear((open) => !open)}
            aria-expanded={confirmClear}
          >
            <Trash2Icon className="size-3.5" aria-hidden />
            {t("clearLog")}
          </Button>
        </div>
      }
    >
      <MotionCollapse open={confirmClear}>
        <Alert variant="destructive" data-testid="gateway-log-clear-confirm">
          <AlertDescription className="flex w-full flex-col gap-2 @md/gateway-pane:flex-row @md/gateway-pane:items-center">
            <p className="flex-1">{t("clearLogConfirm")}</p>
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="destructive"
                disabled={clearing}
                onClick={() => void onClear()}
              >
                {clearing ? <Loader2Icon className="size-3.5 animate-spin" aria-hidden /> : null}
                {t("clearLogConfirmAction")}
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setConfirmClear(false)}>
                {t("cancel")}
              </Button>
            </div>
          </AlertDescription>
        </Alert>
      </MotionCollapse>

      <div
        className="grid grid-cols-2 gap-2 @2xl/gateway-pane:grid-cols-4"
        data-testid="gateway-usage-summary"
      >
        <SummaryTile
          label={t("summaryRequests")}
          value={format.number(summary.requests)}
          hint={t("summaryErrorsHint", {
            errors: summary.errors,
            rate: format.number(summary.requests > 0 ? summary.errors / summary.requests : 0, {
              style: "percent",
              maximumFractionDigits: 1,
            }),
          })}
          tone={summary.errors > 0 ? "warn" : undefined}
        />
        <SummaryTile
          label={t("summaryTokens")}
          value={`${format.number(summary.inputTokens)} / ${format.number(summary.outputTokens)}`}
        />
        <SummaryTile
          label={t("summaryAvgLatency")}
          value={t("latencyMs", { ms: summary.avgLatencyMs })}
        />
        <SummaryTile
          label={t("summaryCost")}
          value={totalCost === undefined ? t("costUnknown") : formatUsd(totalCost)}
          testId="gateway-usage-cost"
        />
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <ToggleGroup
          type="single"
          variant="outline"
          size="sm"
          value={outcome}
          onValueChange={(value) => {
            if (value) setOutcome(value as Outcome)
          }}
          aria-label={t("logHeading")}
        >
          {(["all", "ok", "errors"] as const).map((filterOutcome) => (
            <ToggleGroupItem key={filterOutcome} value={filterOutcome}>
              {t(
                filterOutcome === "all"
                  ? "logFilterAll"
                  : filterOutcome === "ok"
                    ? "logFilterOk"
                    : "logFilterErrors"
              )}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <Input
          value={model}
          placeholder={t("logFilterModelPlaceholder")}
          aria-label={t("colModel")}
          className="h-8 min-w-0 flex-1 basis-36 text-xs"
          onChange={(e) => setModel(e.target.value)}
        />
        {/* shadcn Select, not a bare <select>: this was the only native one
              left in the repo and it ignored the app theme. */}
        <Select value={keyFilter} onValueChange={setKeyFilter}>
          <SelectTrigger
            className="h-8 min-w-0 flex-1 basis-36 text-xs @lg/gateway-pane:max-w-48"
            aria-label={t("colKey")}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value={ALL_KEYS}>{t("logFilterAllKeys")}</SelectItem>
              {keys.map((k) => (
                <SelectItem key={k.id} value={k.id}>
                  {k.name}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </div>

      {rows.length === 0 ? (
        <SettingsEmptyState
          icon={<ScrollTextIcon className="size-5" />}
          title={t("logEmpty")}
          className="py-6"
        />
      ) : (
        <div className="flex flex-col gap-2">
          <Table className="text-xs" data-testid="gateway-log">
            <TableHeader className="text-muted-foreground">
              <TableRow className="text-left hover:bg-transparent">
                <TableHead className="w-7 py-1" />
                <TableHead className="py-1 pr-2">{t("colTime")}</TableHead>
                <TableHead className="py-1 pr-2">{t("colModel")}</TableHead>
                <TableHead className={cn("py-1 pr-2", COLUMN_FROM_XL)}>
                  {t("colProvider")}
                </TableHead>
                <TableHead className={cn("py-1 pr-2", COLUMN_FROM_2XL)}>{t("colKey")}</TableHead>
                <TableHead className="py-1 pr-2">{t("colStatus")}</TableHead>
                <TableHead className="py-1 pr-2">{t("colLatency")}</TableHead>
                <TableHead className={cn("py-1 pr-2", COLUMN_FROM_XL)}>{t("colTokens")}</TableHead>
                <TableHead className={cn("py-1 pr-2", COLUMN_FROM_2XL)}>{t("colCost")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody className="font-mono">
              {rows.map((r) => {
                const cost = costs.get(r.id)
                return (
                  <LogRow
                    key={r.id}
                    row={r}
                    keyName={keyName(r.keyId)}
                    costLabel={cost === undefined ? t("costUnknown") : formatUsd(cost)}
                    isFresh={new Date(r.at).getTime() > openedAt}
                    isExpanded={expanded === r.id}
                    onToggle={() => setExpanded((cur) => (cur === r.id ? null : r.id))}
                  />
                )
              })}
            </TableBody>
          </Table>
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
            <span data-testid="gateway-log-window">{t("logShowing", { count: rows.length })}</span>
            {canLoadMore ? (
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  setLimit((current) => Math.min(current + LOG_PAGE_SIZE, GATEWAY_REQUEST_LOG_CAP))
                }
              >
                {t("logLoadMore")}
              </Button>
            ) : null}
          </div>
        </div>
      )}
    </GatewayPanelSection>
  )
}

function LogRow({
  row,
  keyName,
  costLabel,
  isFresh,
  isExpanded,
  onToggle,
}: {
  row: GatewayRequestLogRow
  keyName: string
  costLabel: string
  isFresh: boolean
  isExpanded: boolean
  onToggle: () => void
}) {
  const t = useTranslations("settings.gateway")
  const format = useFormatter()
  const tokens = `${format.number(row.inputTokens ?? 0)} / ${format.number(row.outputTokens ?? 0)}`
  const attempts = row.attempts ?? []

  return (
    <>
      <TableRow className={cn(isExpanded && "border-b-0 bg-muted/40")}>
        <TableCell className="py-1">
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={onToggle}
            aria-expanded={isExpanded}
            aria-label={t("logRowDetailAria", { id: row.id })}
            className="text-muted-foreground"
          >
            <ChevronRightIcon
              className={cn(
                "size-3.5 transition-transform duration-150 motion-reduce:transition-none",
                isExpanded && "rotate-90"
              )}
              aria-hidden
            />
          </Button>
        </TableCell>
        <TableCell className="whitespace-nowrap py-1 pr-2 text-muted-foreground">
          {/* Only genuinely new rows animate; a filter change re-orders the whole
              table and animating 100 rows there drops frames while scrolling. */}
          <MotionReveal disabled={!isFresh}>
            <time dateTime={row.at}>
              {format.dateTime(new Date(row.at), { timeStyle: "medium" })}
            </time>
          </MotionReveal>
        </TableCell>
        <TableCell className="max-w-[8rem] truncate py-1 pr-2">{row.model ?? "—"}</TableCell>
        <TableCell
          className={cn("max-w-[7rem] truncate py-1 pr-2 text-muted-foreground", COLUMN_FROM_XL)}
        >
          {row.providerId ?? "—"}
        </TableCell>
        <TableCell
          className={cn("max-w-[7rem] truncate py-1 pr-2 text-muted-foreground", COLUMN_FROM_2XL)}
        >
          {keyName}
        </TableCell>
        <TableCell className="py-1 pr-2">
          <Badge variant={row.status < 400 ? "secondary" : "destructive"}>{row.status}</Badge>
        </TableCell>
        <TableCell className="whitespace-nowrap py-1 pr-2 text-muted-foreground">
          {t("latencyMs", { ms: row.latencyMs })}
        </TableCell>
        <TableCell
          className={cn("whitespace-nowrap py-1 pr-2 text-muted-foreground", COLUMN_FROM_XL)}
        >
          {tokens}
        </TableCell>
        <TableCell
          className={cn("whitespace-nowrap py-1 pr-2 text-muted-foreground", COLUMN_FROM_2XL)}
          data-testid={`gateway-log-cost-${row.id}`}
        >
          {/* Upstream LLM pricing is quoted in USD, so the currency is fixed —
              but the grouping, decimal separator and symbol placement are not,
              and `$0.0123` hard-coded en-US into every locale. */}
          {costLabel}
        </TableCell>
      </TableRow>
      {/* Borderless while closed: an always-mounted detail row otherwise draws
          a second rule under every request. */}
      <TableRow className={cn("hover:bg-transparent", !isExpanded && "border-0")}>
        <TableCell colSpan={9} className="p-0">
          <MotionCollapse open={isExpanded}>
            <div
              className="flex flex-col gap-2 bg-muted/40 px-3 pb-2.5 pt-1 text-[11px]"
              data-testid={`gateway-log-detail-${row.id}`}
            >
              <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
                <Detail label={t("colProvider")} className={DETAIL_BELOW_XL}>
                  {row.providerId ?? "—"}
                </Detail>
                <Detail label={t("colKey")} className={DETAIL_BELOW_2XL}>
                  {keyName}
                </Detail>
                <Detail label={t("colTokens")} className={DETAIL_BELOW_XL}>
                  {tokens}
                </Detail>
                <Detail label={t("colCost")} className={DETAIL_BELOW_2XL}>
                  {costLabel}
                </Detail>
                <Detail label={t("colRoute")}>{row.route}</Detail>
                <Detail label={t("colRemoteIp")}>{row.remoteIp}</Detail>
                <Detail label={t("colStream")}>
                  {row.stream ? t("streamYes") : t("streamNo")}
                </Detail>
                {row.synthesized ? (
                  <Detail label={t("logSynthesized")}>{t("logSynthesizedValue")}</Detail>
                ) : null}
                {row.keyFingerprint ? (
                  <Detail label={t("logUpstreamKey")}>{row.keyFingerprint}</Detail>
                ) : null}
                {row.strategy ? <Detail label={t("logStrategy")}>{row.strategy}</Detail> : null}
                {row.distribution ? (
                  <Detail label={t("logDistribution")}>{row.distribution}</Detail>
                ) : null}
                {row.selectedDeployment ? (
                  <Detail label={t("logSelectedDeployment")}>{row.selectedDeployment}</Detail>
                ) : null}
                {row.routingLatencyMs != null ? (
                  <Detail label={t("logRoutingLatency")}>
                    {t("latencyMs", { ms: row.routingLatencyMs })}
                  </Detail>
                ) : null}
                {row.policyRevision ? (
                  <Detail label={t("logPolicyRevision")}>{row.policyRevision}</Detail>
                ) : null}
                {row.decisionId ? (
                  <Detail label={t("logDecisionId")}>{row.decisionId}</Detail>
                ) : null}
                {row.fallbackReason ? (
                  <Detail label={t("logFallbackReason")} wrap>
                    {row.fallbackReason}
                  </Detail>
                ) : null}
                {row.error ? (
                  <Detail label={t("colError")} wrap tone="error">
                    {row.error}
                  </Detail>
                ) : null}
              </dl>

              {attempts.length > 0 ? (
                <div className="flex flex-col gap-1" data-testid={`gateway-log-attempts-${row.id}`}>
                  <p className="text-muted-foreground">
                    {t("logAttempts", { count: attempts.length })}
                  </p>
                  <ol className="flex flex-col gap-1 border-l pl-3">
                    {attempts.map((attempt, index) => {
                      const ok = attempt.status != null && attempt.status < 400
                      return (
                        <li
                          key={`${attempt.providerId}-${attempt.modelId}-${index}`}
                          className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5"
                        >
                          <span className="tabular-nums text-muted-foreground">{index + 1}.</span>
                          <span className="min-w-0 truncate">
                            {attempt.providerId} · {attempt.modelId}
                          </span>
                          <Badge
                            variant={ok ? "secondary" : "destructive"}
                            className="px-1.5 py-0 text-[10px]"
                          >
                            {attempt.status ?? t("selfCheckNoStatus")}
                          </Badge>
                          <span className="tabular-nums text-muted-foreground">
                            {t("latencyMs", { ms: attempt.latencyMs })}
                          </span>
                          {attempt.reason ? (
                            <span className="basis-full break-words text-muted-foreground">
                              {attempt.reason}
                            </span>
                          ) : null}
                        </li>
                      )
                    })}
                  </ol>
                </div>
              ) : null}
            </div>
          </MotionCollapse>
        </TableCell>
      </TableRow>
    </>
  )
}

/** One `dt`/`dd` pair; `className` hides both together (see the column classes). */
function Detail({
  label,
  children,
  className,
  wrap = false,
  tone,
}: {
  label: string
  children: React.ReactNode
  className?: string
  wrap?: boolean
  tone?: "error"
}) {
  return (
    <>
      <dt className={cn("text-muted-foreground", className)}>{label}</dt>
      <dd
        className={cn(
          wrap ? "whitespace-pre-wrap break-all" : "truncate",
          tone === "error" && "text-destructive",
          className
        )}
      >
        {children}
      </dd>
    </>
  )
}

function SummaryTile({
  label,
  value,
  hint,
  tone,
  testId,
}: {
  label: string
  value: string
  hint?: string
  tone?: "warn"
  testId?: string
}) {
  return (
    <ItemGroup>
      <Item role="listitem" variant="muted" size="sm" data-testid={testId}>
        <ItemContent className="min-w-0">
          <ItemDescription className="text-[11px]">{label}</ItemDescription>
          <ItemTitle className="w-full truncate text-sm tabular-nums">{value}</ItemTitle>
          {hint ? (
            <p
              className={cn(
                "truncate text-[11px] text-muted-foreground",
                tone === "warn" && "text-warning"
              )}
            >
              {hint}
            </p>
          ) : null}
        </ItemContent>
      </Item>
    </ItemGroup>
  )
}
