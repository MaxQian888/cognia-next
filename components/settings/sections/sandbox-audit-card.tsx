"use client"

// ADR-0028 Phase 14 — Sandbox event log card.
//
// Reads the shared `automationAuditLog` Dexie table, filters for
// `surface === "sandbox"`, and renders the newest 50 rows.

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { RefreshCw } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { listAuditRows } from "@/lib/automation/audit"

interface AuditRow {
  id: string
  ts: number
  surface: string
  command: string
  decision: string
  reason?: string
  durationMs?: number
  error?: string
  processName?: string
  windowTitle?: string
}

const LIMIT = 50

async function fetchRows(): Promise<AuditRow[]> {
  if (typeof window === "undefined") return []
  return (await listAuditRows({ surface: "sandbox", limit: LIMIT })) as AuditRow[]
}

export function SandboxAuditCard() {
  const t = useTranslations("settings.diagnostics.sandboxAudit")
  const [rows, setRows] = useState<AuditRow[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [refreshNonce, setRefreshNonce] = useState(0)

  const refresh = () => setRefreshNonce((n) => n + 1)

  useEffect(() => {
    let cancelled = false
    const run = async () => {
      setLoading(true)
      try {
        const next = await fetchRows()
        if (cancelled) return
        setRows(next)
        setError(null)
      } catch (err: unknown) {
        if (cancelled) return
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (!cancelled) setLoading(false)
      }
    }
    void run()
    return () => {
      cancelled = true
    }
  }, [refreshNonce])

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <div>
          <CardTitle>{t("title")}</CardTitle>
          <CardDescription>{t("description")}</CardDescription>
        </div>
        <Button
          variant="outline"
          size="sm"
          onClick={refresh}
          disabled={loading}
          data-testid="sandbox-audit-refresh"
        >
          <RefreshCw className="size-4" aria-hidden="true" />
          {t("refresh")}
        </Button>
      </CardHeader>
      <CardContent className="space-y-2 text-xs">
        {error && (
          <p className="text-rose-500" role="alert">
            {error}
          </p>
        )}
        {rows.length === 0 && !loading && !error && (
          <p className="text-muted-foreground" data-testid="sandbox-audit-empty">
            {t("empty")}
          </p>
        )}
        {rows.length > 0 && (
          <ul
            className="max-h-64 space-y-1 overflow-y-auto rounded-md border p-2 font-mono"
            data-testid="sandbox-audit-list"
          >
            {rows.map((row) => (
              <li key={row.id} className="flex flex-wrap gap-2">
                <span className="text-muted-foreground">
                  {new Date(row.ts).toLocaleTimeString()}
                </span>
                <span>{row.command}</span>
                <span
                  className={
                    row.decision === "allow"
                      ? "text-emerald-500"
                      : row.decision === "deny"
                        ? "text-rose-500"
                        : "text-amber-500"
                  }
                >
                  {row.decision}
                </span>
                {typeof row.durationMs === "number" && (
                  <span className="text-muted-foreground">{row.durationMs}ms</span>
                )}
                {row.error && <span className="text-rose-500 break-all">{row.error}</span>}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  )
}
