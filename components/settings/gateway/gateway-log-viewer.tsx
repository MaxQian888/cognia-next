"use client"

/**
 * Gateway request-log viewer (desktop only).
 *
 * Reads the durable `gatewayRequestLog` Dexie table (fed by `GatewayProvider`
 * from the `gateway://request-log` event) via a live query, with outcome +
 * model filters, usage summary tiles, and a clear action — the newapi "Logs"
 * page equivalent.
 */

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { Trash2Icon } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import {
  clearGatewayRequestLog,
  listGatewayRequestLog,
  summarizeGatewayUsage,
  type GatewayRequestLogFilter,
} from "@/lib/db/gateway-request-log"
import { gatewayListKeys } from "@/lib/tauri/gateway"
import type { GatewayApiKeyRedacted } from "@/types/gateway"

type Outcome = "all" | "ok" | "errors"

export function GatewayLogViewer() {
  const t = useTranslations("settings.gateway")
  const [outcome, setOutcome] = useState<Outcome>("all")
  const [model, setModel] = useState("")
  const [keyFilter, setKeyFilter] = useState("all")
  const [keys, setKeys] = useState<GatewayApiKeyRedacted[]>([])

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
      if (keyFilter !== "all") filter.keyId = keyFilter
      return listGatewayRequestLog(filter)
    }, [outcome, model, keyFilter]) ?? []

  const summary = summarizeGatewayUsage(rows)

  const onClear = async () => {
    await clearGatewayRequestLog().catch(() => {})
    toast.success(t("logCleared"))
  }

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center justify-between text-sm font-medium">
          {t("logHeading")}
          <Button size="sm" variant="ghost" onClick={() => void onClear()}>
            <Trash2Icon className="mr-1.5 h-3.5 w-3.5" />
            {t("clearLog")}
          </Button>
        </CardTitle>
        <CardDescription>{t("logHelp")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Usage summary */}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="gateway-usage-summary">
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
          <div className="flex gap-1" role="group" aria-label={t("logHeading")}>
            {(["all", "ok", "errors"] as const).map((o) => (
              <Button
                key={o}
                size="sm"
                variant={outcome === o ? "default" : "outline"}
                onClick={() => setOutcome(o)}
              >
                {t(o === "all" ? "logFilterAll" : o === "ok" ? "logFilterOk" : "logFilterErrors")}
              </Button>
            ))}
          </div>
          <Input
            value={model}
            placeholder={t("logFilterModelPlaceholder")}
            aria-label={t("colModel")}
            className="h-8 w-40 text-xs"
            onChange={(e) => setModel(e.target.value)}
          />
          <select
            value={keyFilter}
            aria-label={t("colKey")}
            className="h-8 rounded-md border bg-background px-2 text-xs"
            onChange={(e) => setKeyFilter(e.target.value)}
          >
            <option value="all">{t("logFilterAllKeys")}</option>
            {keys.map((k) => (
              <option key={k.id} value={k.id}>
                {k.name}
              </option>
            ))}
          </select>
        </div>

        {/* Rows */}
        {rows.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t("logEmpty")}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs" data-testid="gateway-log">
              <thead className="text-muted-foreground">
                <tr className="border-b text-left">
                  <th className="py-1 pr-2 font-medium">{t("colTime")}</th>
                  <th className="py-1 pr-2 font-medium">{t("colModel")}</th>
                  <th className="py-1 pr-2 font-medium">{t("colProvider")}</th>
                  <th className="py-1 pr-2 font-medium">{t("colKey")}</th>
                  <th className="py-1 pr-2 font-medium">{t("colStatus")}</th>
                  <th className="py-1 pr-2 font-medium">{t("colLatency")}</th>
                  <th className="py-1 pr-2 font-medium">{t("colTokens")}</th>
                </tr>
              </thead>
              <tbody className="font-mono">
                {rows.map((r) => (
                  <tr key={r.id} className="border-b/50 border-b">
                    <td className="whitespace-nowrap py-1 pr-2 text-muted-foreground">
                      {new Date(r.at).toLocaleTimeString()}
                    </td>
                    <td className="max-w-[8rem] truncate py-1 pr-2">{r.model ?? "—"}</td>
                    <td className="max-w-[7rem] truncate py-1 pr-2 text-muted-foreground">
                      {r.providerId ?? "—"}
                    </td>
                    <td className="max-w-[7rem] truncate py-1 pr-2 text-muted-foreground">
                      {keyName(r.keyId)}
                    </td>
                    <td className="py-1 pr-2">
                      <Badge variant={r.status < 400 ? "secondary" : "destructive"}>
                        {r.status}
                      </Badge>
                    </td>
                    <td className="py-1 pr-2 text-muted-foreground">{r.latencyMs}ms</td>
                    <td className="py-1 pr-2 text-muted-foreground">
                      {(r.inputTokens ?? 0) + " / " + (r.outputTokens ?? 0)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function SummaryTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md border bg-muted/30 p-2">
      <p className="text-[11px] text-muted-foreground">{label}</p>
      <p className="text-sm font-semibold tabular-nums">{value}</p>
    </div>
  )
}

export default GatewayLogViewer
