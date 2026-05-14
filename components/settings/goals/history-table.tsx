"use client"

import { useLiveQuery } from "dexie-react-hooks"
import { listAllGoals } from "@/lib/db/goals"
import type { Goal } from "@/types/goal"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

export function GoalsHistoryTable() {
  const goals = useLiveQuery(() => listAllGoals(500), [])

  if (!goals) return <p className="text-sm text-muted-foreground">Loading…</p>

  if (goals.length === 0) {
    return (
      <p
        className="rounded-md border border-dashed bg-muted/30 p-4 text-sm text-muted-foreground"
        data-testid="goals-history-empty"
      >
        No goals yet. Use <code>/goal &lt;text&gt;</code> in any chat to start one.
      </p>
    )
  }

  return (
    <Table data-testid="goals-history-table">
      <TableHeader>
        <TableRow>
          <TableHead>Objective</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Turns</TableHead>
          <TableHead>Tokens</TableHead>
          <TableHead>Created</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {goals.map((g) => (
          <TableRow key={g.id} data-testid="goals-history-row">
            <TableCell className="max-w-xs truncate" title={g.safeObjective}>
              {g.safeObjective}
            </TableCell>
            <TableCell>{renderStatus(g)}</TableCell>
            <TableCell>{g.turnsUsed}</TableCell>
            <TableCell>{g.tokensUsed.toLocaleString()}</TableCell>
            <TableCell>{new Date(g.createdAt).toLocaleString()}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}

function renderStatus(g: Goal): string {
  return g.status
}
