"use client"

/**
 * Audit log table — newest-first listing of automation Tauri command calls.
 * Reads from the Dexie `automationAuditLog` table via the
 * `lib/automation/audit.ts` helpers. The table is capped at 5000 rows by
 * `recordAuditRow`.
 */

import { useCallback, useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { Trash2Icon, DownloadIcon, FilterIcon } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

import { clearAuditLog, listAuditRows } from "@/lib/automation/audit"
import type { AutomationAuditLogRow } from "@/lib/db/schema"

type SurfaceFilter = "all" | AutomationAuditLogRow["surface"]
type DecisionFilter = "all" | AutomationAuditLogRow["decision"]

export function AutomationAuditTable() {
  const t = useTranslations("automation.audit")
  const tFilters = useTranslations("automation.audit.filters")
  const tColumns = useTranslations("automation.audit.columns")
  const [rows, setRows] = useState<AutomationAuditLogRow[]>([])
  const [loading, setLoading] = useState(true)
  const [surfaceFilter, setSurfaceFilter] = useState<SurfaceFilter>("all")
  const [decisionFilter, setDecisionFilter] = useState<DecisionFilter>("all")

  const reload = useCallback(async () => {
    setLoading(true)
    try {
      const r = await listAuditRows({
        surface: surfaceFilter === "all" ? undefined : surfaceFilter,
        decision: decisionFilter === "all" ? undefined : decisionFilter,
        limit: 500,
      })
      setRows(r)
    } catch (err) {
      toast.error("Failed to load audit log", { description: String(err) })
    } finally {
      setLoading(false)
    }
  }, [surfaceFilter, decisionFilter])

  useEffect(() => {
    let cancelled = false
    queueMicrotask(() => {
      if (!cancelled) void reload()
    })
    return () => {
      cancelled = true
    }
  }, [reload])

  const counts = useMemo(() => {
    return {
      total: rows.length,
      allow: rows.filter((r) => r.decision === "allow").length,
      deny: rows.filter((r) => r.decision === "deny").length,
      consent: rows.filter((r) => r.decision === "consent").length,
    }
  }, [rows])

  async function handleClear() {
    if (
      typeof window !== "undefined" &&
      !window.confirm("Clear the entire automation audit log? This cannot be undone.")
    ) {
      return
    }
    await clearAuditLog()
    await reload()
    toast.success("Audit log cleared")
  }

  function handleExport() {
    const csv = rowsToCsv(rows)
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" })
    const url = URL.createObjectURL(blob)
    const a = document.createElement("a")
    a.href = url
    a.download = `automation-audit-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div>
          <CardTitle>{t("title")}</CardTitle>
          <CardDescription>
            {t("description")} {counts.total} —{" "}
            <Badge variant="outline">
              {counts.allow} {tFilters("decisionAllow")}
            </Badge>{" "}
            <Badge variant="outline">
              {counts.deny} {tFilters("decisionDeny")}
            </Badge>{" "}
            <Badge variant="outline">
              {counts.consent} {tFilters("decisionConsent")}
            </Badge>
          </CardDescription>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={handleExport} disabled={rows.length === 0}>
            <DownloadIcon className="size-4" /> {t("exportCsv")}
          </Button>
          <Button variant="outline" size="sm" onClick={handleClear} disabled={rows.length === 0}>
            <Trash2Icon className="size-4" /> {t("clear")}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center gap-2 text-sm">
          <FilterIcon className="size-4 text-muted-foreground" />
          <Select value={surfaceFilter} onValueChange={(v) => setSurfaceFilter(v as SurfaceFilter)}>
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{tFilters("allSurfaces")}</SelectItem>
              <SelectItem value="workflow">{tFilters("surfaceWorkflow")}</SelectItem>
              <SelectItem value="computerUse">{tFilters("surfaceComputerUse")}</SelectItem>
              <SelectItem value="mcp">{tFilters("surfaceMcp")}</SelectItem>
              <SelectItem value="plugin">{tFilters("surfacePlugin")}</SelectItem>
            </SelectContent>
          </Select>
          <Select
            value={decisionFilter}
            onValueChange={(v) => setDecisionFilter(v as DecisionFilter)}
          >
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">{tFilters("allDecisions")}</SelectItem>
              <SelectItem value="allow">{tFilters("decisionAllow")}</SelectItem>
              <SelectItem value="deny">{tFilters("decisionDeny")}</SelectItem>
              <SelectItem value="consent">{tFilters("decisionConsent")}</SelectItem>
            </SelectContent>
          </Select>
        </div>

        {loading ? (
          <p className="text-sm text-muted-foreground">{t("loading")}</p>
        ) : rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("empty")}</p>
        ) : (
          <div className="max-h-[480px] overflow-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{tColumns("time")}</TableHead>
                  <TableHead>{tColumns("surface")}</TableHead>
                  <TableHead>{tColumns("command")}</TableHead>
                  <TableHead>{tColumns("decision")}</TableHead>
                  <TableHead>{tColumns("target")}</TableHead>
                  <TableHead className="text-right">{tColumns("duration")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="font-mono text-xs">
                      {new Date(row.ts).toLocaleString()}
                    </TableCell>
                    <TableCell>{row.surface}</TableCell>
                    <TableCell className="font-mono text-xs">{row.command}</TableCell>
                    <TableCell>
                      <Badge
                        variant={
                          row.decision === "allow"
                            ? "secondary"
                            : row.decision === "deny"
                              ? "destructive"
                              : "outline"
                        }
                      >
                        {row.decision}
                      </Badge>
                    </TableCell>
                    <TableCell className="text-xs">
                      {row.processName ?? row.windowTitle ?? "—"}
                    </TableCell>
                    <TableCell className="text-right font-mono text-xs">
                      {row.durationMs}ms
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}

function rowsToCsv(rows: AutomationAuditLogRow[]): string {
  const headers = [
    "id",
    "ts",
    "isoTime",
    "surface",
    "pluginId",
    "command",
    "decision",
    "reason",
    "processName",
    "windowTitle",
    "durationMs",
    "error",
  ]
  const escape = (v: string | number | null | undefined) => {
    if (v === null || v === undefined) return ""
    const s = String(v)
    if (s.includes(",") || s.includes('"') || s.includes("\n")) {
      return `"${s.replace(/"/g, '""')}"`
    }
    return s
  }
  const lines = [headers.join(",")]
  for (const r of rows) {
    lines.push(
      [
        r.id,
        r.ts,
        new Date(r.ts).toISOString(),
        r.surface,
        r.pluginId,
        r.command,
        r.decision,
        r.reason,
        r.processName,
        r.windowTitle,
        r.durationMs,
        r.error,
      ]
        .map(escape)
        .join(",")
    )
  }
  return lines.join("\n")
}
