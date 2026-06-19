"use client"

/**
 * Capability matrix view (ADR-0009 v41 / E1).
 *
 * Renders a 37-row × N-column table where rows are the 37 A2UI component
 * kinds the bus knows about, columns are the currently-configured adapter
 * instances, and cells show how each adapter projects each component —
 * `native` / `simulated` / `fallback` / `unsupported`. The data comes from
 * `AdapterInstanceRow.lastKnownCapabilities`, written by the adapter
 * startup probe. Rows that have never started (or pre-v38 rows) read as
 * "fallback" everywhere — matching the runtime's safe default.
 *
 * Color legend matches the four-tier capability prompt:
 *   green   = native (synchronous, fully featured)
 *   amber   = simulated (multi-step UX)
 *   gray    = fallback (degrades to plain text)
 *   red     = unsupported (do not emit)
 */

import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { getDb } from "@/lib/db/schema"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Badge } from "@/components/ui/badge"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import {
  A2UI_COMPONENT_KINDS,
  type A2UIComponentKind,
  type A2UIComponentSupport,
} from "@/types/connectors/capability"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"

function tierClassName(support: A2UIComponentSupport): string {
  switch (support) {
    case "native":
      return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
    case "simulated":
      return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300"
    case "fallback":
      return "border-muted-foreground/30 bg-muted text-muted-foreground"
    case "unsupported":
      return "border-destructive/30 bg-destructive/10 text-destructive dark:text-destructive"
  }
}

function resolveCell(adapter: AdapterInstanceRow, kind: A2UIComponentKind): A2UIComponentSupport {
  const matrix = adapter.lastKnownCapabilities
  if (!matrix) return "fallback"
  return matrix[kind] ?? "fallback"
}

export function CapabilityMatrixTab() {
  const t = useTranslations("settings.connections.capabilityMatrix")
  const tTiers = useTranslations("settings.connections.capabilityMatrix.tiers")
  const tKinds = useTranslations("settings.connections.capabilityMatrix.componentKinds")
  const kindLabel = (kind: A2UIComponentKind) => (tKinds.has(kind) ? tKinds(kind) : kind)

  const adapters = useLiveQuery<AdapterInstanceRow[]>(
    () =>
      typeof window === "undefined" ? Promise.resolve([]) : getDb().adapterInstances.toArray(),
    []
  )

  if (!adapters || adapters.length === 0) {
    return (
      <div
        className="rounded border p-6 text-sm text-muted-foreground"
        data-testid="capability-matrix-empty"
      >
        {t("emptyState")}
      </div>
    )
  }

  return (
    <div className="space-y-3" data-testid="capability-matrix-tab">
      <p className="text-xs text-muted-foreground">{t("intro")}</p>

      <div className="overflow-x-auto rounded border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-48">{t("componentColumn")}</TableHead>
              {adapters.map((a) => (
                <TableHead key={a.id} className="text-xs" data-testid={`capability-col-${a.id}`}>
                  <div className="flex flex-col">
                    <span className="font-semibold">{a.displayName}</span>
                    <span className="text-[10px] text-muted-foreground">{a.type}</span>
                  </div>
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {A2UI_COMPONENT_KINDS.map((kind) => (
              <TableRow key={kind} data-testid={`capability-row-${kind}`}>
                <TableCell className="text-xs">
                  <span className="font-medium">{kindLabel(kind)}</span>
                  <span className="ml-1.5 font-mono text-[10px] text-muted-foreground">{kind}</span>
                </TableCell>
                {adapters.map((adapter) => {
                  const support = resolveCell(adapter, kind)
                  return (
                    <TableCell key={adapter.id} className="text-center">
                      <Tooltip>
                        <TooltipTrigger asChild>
                          <Badge
                            variant="outline"
                            className={cn("text-[10px] font-medium", tierClassName(support))}
                            data-testid={`capability-cell-${adapter.id}-${kind}`}
                            data-tier={support}
                          >
                            {tTiers(support)}
                          </Badge>
                        </TooltipTrigger>
                        <TooltipContent side="top" className="text-xs">
                          {`${adapter.displayName} · ${kindLabel(kind)} · ${tTiers(support)}`}
                        </TooltipContent>
                      </Tooltip>
                    </TableCell>
                  )
                })}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      <div className="flex flex-wrap gap-2 pt-2 text-xs text-muted-foreground">
        <Badge variant="outline" className={cn(tierClassName("native"), "text-[10px]")}>
          {tTiers("native")}
        </Badge>
        <Badge variant="outline" className={cn(tierClassName("simulated"), "text-[10px]")}>
          {tTiers("simulated")}
        </Badge>
        <Badge variant="outline" className={cn(tierClassName("fallback"), "text-[10px]")}>
          {tTiers("fallback")}
        </Badge>
        <Badge variant="outline" className={cn(tierClassName("unsupported"), "text-[10px]")}>
          {tTiers("unsupported")}
        </Badge>
      </div>
    </div>
  )
}
