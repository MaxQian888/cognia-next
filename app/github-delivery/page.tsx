"use client"

/**
 * /github-delivery — independent kanban view of GitHub work orders.
 *
 * Lays out the github-delivery plugin's namespaced `workOrders` table as a
 * 6-column kanban (Open / In progress / PR opened / Awaiting review / Merged
 * / Failed). Each card shows the issue number, repo, AI driver, and a peek
 * at the work-order metadata.
 *
 * The page is fully client-side and degrades to an empty state when the
 * plugin isn't enabled — same pattern as the Settings → GitHub Delivery
 * Repos tab.
 */

import { useMemo } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { GitBranchIcon, AlertTriangleIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Card } from "@/components/ui/card"
import { getDb } from "@/lib/db/schema"
import type { GhWorkOrder, WorkOrderStatus } from "@/lib/github/types"
import type Dexie from "dexie"

const NAMESPACED_TABLE = "github-delivery:workOrders"

const COLUMNS: { id: WorkOrderStatus; label: string }[] = [
  { id: "open", label: "Open" },
  { id: "in_progress", label: "In progress" },
  { id: "pr_opened", label: "PR opened" },
  { id: "awaiting_review", label: "Awaiting review" },
  { id: "merged", label: "Merged" },
  { id: "failed", label: "Failed" },
]

function getWorkOrdersTable(): Dexie.Table<GhWorkOrder, number> | null {
  try {
    const db = getDb() as unknown as Dexie
    return db.table<GhWorkOrder, number>(NAMESPACED_TABLE)
  } catch {
    return null
  }
}

export default function GithubDeliveryPage() {
  const orders = useLiveQuery(async () => {
    const t = getWorkOrdersTable()
    if (!t) return null
    try {
      return await t.orderBy("updatedAt").reverse().toArray()
    } catch {
      return null
    }
  })

  const grouped = useMemo(() => {
    const m = new Map<WorkOrderStatus, GhWorkOrder[]>()
    for (const col of COLUMNS) m.set(col.id, [])
    if (orders) {
      for (const order of orders) {
        m.get(order.status)?.push(order)
      }
    }
    return m
  }, [orders])

  if (orders === null) {
    return (
      <main className="p-6 space-y-3" data-bg-target="chat">
        <h1 className="text-xl font-semibold">GitHub Delivery</h1>
        <Card className="p-6 space-y-2">
          <div className="flex items-center gap-2 text-muted-foreground">
            <GitBranchIcon className="h-4 w-4" />
            <span className="text-sm">The GitHub Delivery plugin is not enabled.</span>
          </div>
          <p className="text-xs text-muted-foreground">
            Enable it from Settings → Plugins → Marketplace to start receiving GitHub events.
          </p>
        </Card>
      </main>
    )
  }

  return (
    <main className="p-6 space-y-4" data-testid="github-delivery-kanban" data-bg-target="chat">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-semibold">GitHub Delivery</h1>
          <p className="text-sm text-muted-foreground">
            AI-driven Issue → PR work orders.{" "}
            {orders === undefined ? "Loading…" : `${orders.length} total`}
          </p>
        </div>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-3 xl:grid-cols-6 gap-3">
        {COLUMNS.map((col) => {
          const rows = grouped.get(col.id) ?? []
          return (
            <section key={col.id} className="space-y-2" data-testid={`kanban-col-${col.id}`}>
              <h2 className="text-xs uppercase tracking-wide text-muted-foreground flex items-center gap-2">
                {col.label}
                <Badge variant="outline" className="text-[10px]">
                  {rows.length}
                </Badge>
              </h2>
              {rows.length === 0 ? (
                <p className="text-xs text-muted-foreground">—</p>
              ) : (
                rows.map((row, idx) => (
                  <Card key={row.id ?? idx} className="p-3 space-y-1.5">
                    <div className="flex items-center gap-2">
                      <span className="font-mono text-xs">#{row.issueNumber}</span>
                      <span className="text-xs text-muted-foreground truncate">
                        {row.repoFullName}
                      </span>
                    </div>
                    {row.aiDriver && (
                      <Badge variant="secondary" className="text-[10px]">
                        {row.aiDriver}
                      </Badge>
                    )}
                    {row.lastError && col.id === "failed" && (
                      <div className="flex items-center gap-1 text-xs text-destructive">
                        <AlertTriangleIcon className="h-3 w-3 shrink-0" />
                        <span className="truncate">{row.lastError}</span>
                      </div>
                    )}
                    {row.prNumber && (
                      <p className="text-xs text-muted-foreground">PR #{row.prNumber}</p>
                    )}
                  </Card>
                ))
              )}
            </section>
          )
        })}
      </div>
    </main>
  )
}
