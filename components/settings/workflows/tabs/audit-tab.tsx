"use client"

import { useLiveQuery } from "dexie-react-hooks"
import { ScrollTextIcon } from "lucide-react"
import { getDb } from "@/lib/db/schema"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"
import { Badge } from "@/components/ui/badge"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"

/**
 * The audit table will live alongside `mcpAuditLog` / `connectorAudit` once
 * the runtime engine ships. For now the tab surfaces an empty state that
 * explains what will populate it; downstream phases hook the runtime into
 * the existing `mcpAuditLog` table so workflow-related audit lines flow into
 * the same Settings audit surface.
 */
export function AuditTab() {
  const recent = useLiveQuery(
    async () =>
      getDb()
        .mcpAuditLog.where("tool")
        .startsWithIgnoreCase("workflow")
        .reverse()
        .limit(50)
        .toArray()
        .catch(() => []),
    []
  )

  if (recent === undefined) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-full" />
        ))}
      </div>
    )
  }

  if (recent.length === 0) {
    return (
      <Empty className="mx-auto max-w-md py-12">
        <EmptyHeader>
          <EmptyMedia>
            <ScrollTextIcon className="size-8" aria-hidden="true" />
          </EmptyMedia>
        </EmptyHeader>
        <EmptyTitle>Audit log</EmptyTitle>
        <EmptyDescription>
          Workflow run starts, step failures, secret access, and trigger registrations will be
          logged here. The audit log shares storage with the External Bridge MCP audit log to keep
          one searchable record across all extension surfaces.
        </EmptyDescription>
      </Empty>
    )
  }

  return (
    <div className="rounded-md border overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Time</TableHead>
            <TableHead>Tool</TableHead>
            <TableHead>Result</TableHead>
            <TableHead>Reason</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {recent.map((row) => (
            <TableRow key={row.id}>
              <TableCell className="text-xs text-muted-foreground">
                {new Date(row.ts).toLocaleString()}
              </TableCell>
              <TableCell className="font-mono text-xs">{row.tool}</TableCell>
              <TableCell>
                <Badge
                  variant="outline"
                  className={
                    row.allowed
                      ? "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300"
                      : "bg-rose-500/15 text-rose-700 dark:text-rose-300"
                  }
                >
                  {row.allowed ? "allowed" : "denied"}
                </Badge>
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">{row.reason ?? "—"}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
