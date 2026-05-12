"use client"

/**
 * Audit sub-tab. Live-queries the github-delivery plugin's namespaced audit
 * table to show every policy decision (allow + deny) the bot has made.
 */

import { useLiveQuery } from "dexie-react-hooks"
import { CheckCircle2Icon, XCircleIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"
import type { GhAuditEntry } from "@/lib/github/types"
import { getDb } from "@/lib/db/schema"
import type Dexie from "dexie"

const NAMESPACED_TABLE = "github-delivery:audit"

function getAuditTable(): Dexie.Table<GhAuditEntry, number> | null {
  try {
    const db = getDb() as unknown as Dexie
    return db.table<GhAuditEntry, number>(NAMESPACED_TABLE)
  } catch {
    return null
  }
}

export function AuditTab() {
  const rows = useLiveQuery(async () => {
    const t = getAuditTable()
    if (!t) return null
    try {
      return await t.orderBy("at").reverse().limit(200).toArray()
    } catch {
      return null
    }
  })

  if (rows === null) {
    return (
      <Card className="p-4">
        <p className="text-sm text-muted-foreground">
          Audit log requires the GitHub Delivery plugin to be enabled.
        </p>
      </Card>
    )
  }

  if (rows === undefined) {
    return (
      <Card className="p-4">
        <p className="text-sm text-muted-foreground">Loading audit log…</p>
      </Card>
    )
  }

  if (rows.length === 0) {
    return (
      <Card className="p-4">
        <p className="text-sm text-muted-foreground">
          No audit entries yet. Allow / deny decisions are recorded automatically as workflows run.
        </p>
      </Card>
    )
  }

  return (
    <div className="space-y-2" data-testid="audit-list">
      {rows.map((row, i) => {
        const allowed = row.decision.allow
        return (
          <Card key={row.id ?? i} className="p-3">
            <div className="flex items-center gap-3">
              {allowed ? (
                <CheckCircle2Icon className="h-4 w-4 text-emerald-500" />
              ) : (
                <XCircleIcon className="h-4 w-4 text-destructive" />
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <Badge variant="secondary" className="font-mono text-xs">
                    {row.action.kind}
                  </Badge>
                  <span className="font-mono text-xs text-muted-foreground">
                    {row.repoFullName}
                  </span>
                  {row.runId && (
                    <span className="text-xs text-muted-foreground">run: {row.runId.slice(0, 10)}</span>
                  )}
                </div>
                {row.reason && (
                  <p className="text-xs text-muted-foreground mt-0.5">{row.reason}</p>
                )}
              </div>
              <span className="text-xs text-muted-foreground whitespace-nowrap">
                {new Date(row.at).toLocaleString()}
              </span>
            </div>
          </Card>
        )
      })}
    </div>
  )
}
