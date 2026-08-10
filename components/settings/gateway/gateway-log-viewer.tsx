"use client"

/**
 * Gateway request-log viewer (desktop only).
 *
 * Reads the durable `gatewayRequestLog` Dexie table (fed by `GatewayProvider`
 * from the `gateway://request-log` event) via a live query, with outcome +
 * model + key filters, usage summary tiles, and a clear action — the newapi
 * "Logs" page equivalent.
 *
 * `GatewayRequestLogRow` has always carried `error`, `route`, `remoteIp` and
 * `stream`; none of them were rendered, so a failing request showed a red
 * status badge and nothing else to act on. They are now on an expandable
 * detail row. Cost comes from `estimateCallCostUsd` — the same estimator the
 * routed workflow nodes price with, not a second implementation.
 */

import { useEffect, useMemo, useState } from "react"
import { useFormatter, useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { ChevronRightIcon, ScrollTextIcon, Trash2Icon } from "lucide-react"
import { toast } from "sonner"

import { estimateCallCostUsd } from "@cognia/provider-core/providers/model-pricing"
import { MotionCollapse, MotionReveal } from "@/components/chat/motion/motion-reveal"
import { SettingsEmptyState } from "@/components/settings/common/settings-section"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
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
  listGatewayRequestLog,
  summarizeGatewayUsage,
  type GatewayRequestLogFilter,
} from "@/lib/db/gateway-request-log"
import { gatewayListKeys } from "@/lib/tauri/gateway"
import type { GatewayApiKeyRedacted, GatewayRequestLogRow } from "@/types/gateway"

import { GatewayPanelSection } from "./shared/panel-section"

type Outcome = "all" | "ok" | "errors"

const ALL_KEYS = "all"

export function GatewayLogViewer() {
  const t = useTranslations("settings.gateway")
  const [outcome, setOutcome] = useState<Outcome>("all")
  const [model, setModel] = useState("")
  const [keyFilter, setKeyFilter] = useState(ALL_KEYS)
  const [keys, setKeys] = useState<GatewayApiKeyRedacted[]>([])
  const [expanded, setExpanded] = useState<string | null>(null)

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
      const filter: GatewayRequestLogFilter = { limit: 100 }
      if (outcome !== "all") filter.outcome = outcome
      if (model.trim()) filter.model = model.trim()
      if (keyFilter !== ALL_KEYS) filter.keyId = keyFilter
      return listGatewayRequestLog(filter)
    }, [outcome, model, keyFilter]) ?? []

  const summary = summarizeGatewayUsage(rows)
  // "Arrived while you were watching" — anything logged after the panel opened.
  // Derived from the row's own timestamp rather than by diffing renders, so a
  // filter change (which re-orders the whole table) animates nothing, and
  // opening the panel does not slide a hundred historical rows in at once.
  const [openedAt] = useState(() => Date.now())

  const onClear = async () => {
    await clearGatewayRequestLog().catch(() => {})
    toast.success(t("logCleared"))
  }

  return (
    <GatewayPanelSection
      icon={<ScrollTextIcon className="size-4" />}
      title={t("logHeading")}
      description={t("logHelp")}
      action={
        <Button size="sm" variant="ghost" onClick={() => void onClear()}>
          <Trash2Icon className="mr-1.5 h-3.5 w-3.5" />
          {t("clearLog")}
        </Button>
      }
    >
      {/* Usage summary */}
      <div
        className="grid grid-cols-2 gap-2 @lg/gateway-pane:grid-cols-4"
        data-testid="gateway-usage-summary"
      >
        <SummaryTile label={t("summaryRequests")} value={String(summary.requests)} />
        <SummaryTile label={t("summaryErrors")} value={String(summary.errors)} />
        <SummaryTile
          label={t("summaryTokens")}
          value={`${summary.inputTokens} / ${summary.outputTokens}`}
        />
        <SummaryTile label={t("summaryAvgLatency")} value={`${summary.avgLatencyMs}ms`} />
      </div>

      {/* Filters */}
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
          className="h-8 w-40 text-xs"
          onChange={(e) => setModel(e.target.value)}
        />
        {/* shadcn Select, not a bare <select>: this was the only native one
              left in the repo and it ignored the app theme. */}
        <Select value={keyFilter} onValueChange={setKeyFilter}>
          <SelectTrigger className="h-8 w-44 text-xs" aria-label={t("colKey")}>
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

      {/* Rows */}
      {rows.length === 0 ? (
        <SettingsEmptyState
          icon={<ScrollTextIcon className="size-5" />}
          title={t("logEmpty")}
          className="py-6"
        />
      ) : (
        <Table className="text-xs" data-testid="gateway-log">
          <TableHeader className="text-muted-foreground">
            <TableRow className="text-left hover:bg-transparent">
              <TableHead className="w-6 py-1" />
              <TableHead className="py-1 pr-2">{t("colTime")}</TableHead>
              <TableHead className="py-1 pr-2">{t("colModel")}</TableHead>
              <TableHead className="py-1 pr-2">{t("colProvider")}</TableHead>
              <TableHead className="py-1 pr-2">{t("colKey")}</TableHead>
              <TableHead className="py-1 pr-2">{t("colStatus")}</TableHead>
              <TableHead className="py-1 pr-2">{t("colLatency")}</TableHead>
              <TableHead className="py-1 pr-2">{t("colTokens")}</TableHead>
              <TableHead className="py-1 pr-2">{t("colCost")}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody className="font-mono">
            {rows.map((r) => (
              <LogRow
                key={r.id}
                row={r}
                keyName={keyName(r.keyId)}
                isFresh={new Date(r.at).getTime() > openedAt}
                isExpanded={expanded === r.id}
                onToggle={() => setExpanded((cur) => (cur === r.id ? null : r.id))}
              />
            ))}
          </TableBody>
        </Table>
      )}
    </GatewayPanelSection>
  )
}

function LogRow({
  row,
  keyName,
  isFresh,
  isExpanded,
  onToggle,
}: {
  row: GatewayRequestLogRow
  keyName: string
  isFresh: boolean
  isExpanded: boolean
  onToggle: () => void
}) {
  const t = useTranslations("settings.gateway")
  const format = useFormatter()
  const cost = useMemo(() => {
    if (!row.providerId || !row.model) return undefined
    return estimateCallCostUsd({
      providerId: row.providerId,
      modelId: row.model,
      inputTokens: row.inputTokens ?? 0,
      outputTokens: row.outputTokens ?? 0,
    })
  }, [row.providerId, row.model, row.inputTokens, row.outputTokens])

  return (
    <>
      <TableRow>
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
              className={cn("size-3.5 transition-transform", isExpanded && "rotate-90")}
              aria-hidden
            />
          </Button>
        </TableCell>
        <TableCell className="whitespace-nowrap py-1 pr-2 text-muted-foreground">
          {/* Only genuinely new rows animate; a filter change re-orders the whole
              table and animating 100 rows there drops frames while scrolling. */}
          <MotionReveal disabled={!isFresh}>
            <span>{new Date(row.at).toLocaleTimeString()}</span>
          </MotionReveal>
        </TableCell>
        <TableCell className="max-w-[8rem] truncate py-1 pr-2">{row.model ?? "—"}</TableCell>
        <TableCell className="max-w-[7rem] truncate py-1 pr-2 text-muted-foreground">
          {row.providerId ?? "—"}
        </TableCell>
        <TableCell className="max-w-[7rem] truncate py-1 pr-2 text-muted-foreground">
          {keyName}
        </TableCell>
        <TableCell className="py-1 pr-2">
          <Badge variant={row.status < 400 ? "secondary" : "destructive"}>{row.status}</Badge>
        </TableCell>
        <TableCell className="py-1 pr-2 text-muted-foreground">
          {t("latencyMs", { ms: row.latencyMs })}
        </TableCell>
        <TableCell className="py-1 pr-2 text-muted-foreground">
          {(row.inputTokens ?? 0) + " / " + (row.outputTokens ?? 0)}
        </TableCell>
        <TableCell
          className="py-1 pr-2 text-muted-foreground"
          data-testid={`gateway-log-cost-${row.id}`}
        >
          {/* Upstream LLM pricing is quoted in USD, so the currency is fixed —
              but the grouping, decimal separator and symbol placement are not,
              and `$0.0123` hard-coded en-US into every locale. */}
          {cost === undefined
            ? t("costUnknown")
            : format.number(cost, {
                style: "currency",
                currency: "USD",
                minimumFractionDigits: 4,
                maximumFractionDigits: 4,
              })}
        </TableCell>
      </TableRow>
      <TableRow className="hover:bg-transparent">
        <TableCell colSpan={9} className="p-0">
          <MotionCollapse open={isExpanded}>
            <dl
              className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 bg-muted/40 px-3 py-2 text-[11px]"
              data-testid={`gateway-log-detail-${row.id}`}
            >
              <dt className="text-muted-foreground">{t("colRoute")}</dt>
              <dd className="truncate">{row.route}</dd>
              <dt className="text-muted-foreground">{t("colRemoteIp")}</dt>
              <dd className="truncate">{row.remoteIp}</dd>
              <dt className="text-muted-foreground">{t("colStream")}</dt>
              <dd>{row.stream ? t("streamYes") : t("streamNo")}</dd>
              {row.error && (
                <>
                  <dt className="text-muted-foreground">{t("colError")}</dt>
                  <dd className="whitespace-pre-wrap break-all text-destructive">{row.error}</dd>
                </>
              )}
            </dl>
          </MotionCollapse>
        </TableCell>
      </TableRow>
    </>
  )
}

function SummaryTile({ label, value }: { label: string; value: string }) {
  return (
    <ItemGroup>
      <Item role="listitem" variant="muted" size="sm">
        <ItemContent>
          <ItemDescription className="text-[11px]">{label}</ItemDescription>
          <ItemTitle className="text-sm tabular-nums">{value}</ItemTitle>
        </ItemContent>
      </Item>
    </ItemGroup>
  )
}

export default GatewayLogViewer
