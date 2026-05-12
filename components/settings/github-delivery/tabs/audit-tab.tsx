"use client"

/**
 * Audit sub-tab. Live-queries the github-delivery plugin's namespaced audit
 * table to show every policy decision (allow + deny) the bot has made.
 *
 * Filter chips at the top narrow the visible set by repo, decision (allow
 * /deny), and GhAction.kind. Filters are AND'd; an empty filter accepts all
 * values.
 */

import { useMemo, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { CheckCircle2Icon, FilterIcon, XCircleIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import type { GhAction, GhAuditEntry } from "@/lib/github/types"
import { getDb } from "@/lib/db/schema"
import type Dexie from "dexie"

const NAMESPACED_TABLE = "github-delivery:audit"

const ACTION_KINDS: GhAction["kind"][] = [
  "merge",
  "push",
  "release",
  "comment",
  "label",
  "close",
]

type DecisionFilter = "all" | "allow" | "deny"

function getAuditTable(): Dexie.Table<GhAuditEntry, number> | null {
  try {
    const db = getDb() as unknown as Dexie
    return db.table<GhAuditEntry, number>(NAMESPACED_TABLE)
  } catch {
    return null
  }
}

export function AuditTab() {
  const [repoFilter, setRepoFilter] = useState<string>("all")
  const [decisionFilter, setDecisionFilter] = useState<DecisionFilter>("all")
  const [actionFilter, setActionFilter] = useState<string>("all")

  const rows = useLiveQuery(async () => {
    const t = getAuditTable()
    if (!t) return null
    try {
      return await t.orderBy("at").reverse().limit(500).toArray()
    } catch {
      return null
    }
  })

  // Build the repo dropdown options from the rows we've seen.
  const repoOptions = useMemo(() => {
    if (!rows) return []
    return Array.from(new Set(rows.map((r) => r.repoFullName))).sort()
  }, [rows])

  const filtered = useMemo(() => {
    if (!rows) return rows
    return rows.filter((row) => {
      if (repoFilter !== "all" && row.repoFullName !== repoFilter) return false
      if (decisionFilter === "allow" && !row.decision.allow) return false
      if (decisionFilter === "deny" && row.decision.allow) return false
      if (actionFilter !== "all" && row.action.kind !== actionFilter) return false
      return true
    })
  }, [rows, repoFilter, decisionFilter, actionFilter])

  const resetFilters = () => {
    setRepoFilter("all")
    setDecisionFilter("all")
    setActionFilter("all")
  }
  const filtersActive = repoFilter !== "all" || decisionFilter !== "all" || actionFilter !== "all"

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

  return (
    <div className="space-y-3" data-testid="audit-tab">
      <Card className="p-3">
        <div className="flex flex-wrap items-center gap-2" data-testid="audit-filters">
          <FilterIcon className="h-4 w-4 text-muted-foreground" />
          <Select value={repoFilter} onValueChange={setRepoFilter}>
            <SelectTrigger className="w-44" data-testid="audit-filter-repo">
              <SelectValue placeholder="All repos" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All repos</SelectItem>
              {repoOptions.map((r) => (
                <SelectItem key={r} value={r}>
                  {r}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={decisionFilter} onValueChange={(v) => setDecisionFilter(v as DecisionFilter)}>
            <SelectTrigger className="w-32" data-testid="audit-filter-decision">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All</SelectItem>
              <SelectItem value="allow">Allowed</SelectItem>
              <SelectItem value="deny">Denied</SelectItem>
            </SelectContent>
          </Select>
          <Select value={actionFilter} onValueChange={setActionFilter}>
            <SelectTrigger className="w-32" data-testid="audit-filter-action">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All actions</SelectItem>
              {ACTION_KINDS.map((k) => (
                <SelectItem key={k} value={k}>
                  {k}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {filtersActive && (
            <Button size="sm" variant="ghost" onClick={resetFilters} data-testid="audit-clear-filters">
              Clear
            </Button>
          )}
          <span className="ml-auto text-xs text-muted-foreground">
            {filtered?.length ?? 0} of {rows.length}
          </span>
        </div>
      </Card>

      {filtered && filtered.length === 0 ? (
        <Card className="p-4">
          <p className="text-sm text-muted-foreground">
            {rows.length === 0
              ? "No audit entries yet. Allow / deny decisions are recorded automatically as workflows run."
              : "No entries match the current filters."}
          </p>
        </Card>
      ) : (
        <div className="space-y-2" data-testid="audit-list">
          {filtered!.map((row, i) => {
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
                        <span className="text-xs text-muted-foreground">
                          run: {row.runId.slice(0, 10)}
                        </span>
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
      )}
    </div>
  )
}
