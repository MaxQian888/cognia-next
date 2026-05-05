"use client"

import { useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
import { AlertTriangleIcon, ChevronDownIcon, ChevronRightIcon, ShieldIcon } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Card, CardContent } from "@/components/ui/card"
import { Toggle } from "@/components/ui/toggle"
import { getDb } from "@/lib/db/schema"
import type { AuditEntry, AuditKind } from "@/types/connectors/audit"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import { cn } from "@/lib/utils"

// All possible AuditKind values for the filter UI
const ALL_AUDIT_KINDS: AuditKind[] = [
  "delivery.success",
  "delivery.error",
  "delivery.deadlettered",
  "delivery.downgraded",
  "inbound.received",
  "inbound.deduped",
  "inbound.policy_blocked",
  "inbound.signature_failed",
  "outbound.enqueued",
  "circuit.opened",
  "circuit.half_opened",
  "circuit.closed",
  "rate_limit.tripped",
  "credential.refreshed",
  "adapter.started",
  "adapter.stopped",
  "adapter.error",
]

type TimeRange = "1h" | "24h" | "7d" | "all"

const TIME_RANGE_OPTIONS: { value: TimeRange; label: string }[] = [
  { value: "1h", label: "Last hour" },
  { value: "24h", label: "Last 24h" },
  { value: "7d", label: "Last 7d" },
  { value: "all", label: "All" },
]

function timeRangeToMs(range: TimeRange): number | null {
  switch (range) {
    case "1h":
      return 60 * 60 * 1000
    case "24h":
      return 24 * 60 * 60 * 1000
    case "7d":
      return 7 * 24 * 60 * 60 * 1000
    case "all":
      return null
  }
}

function kindBadgeVariant(kind: AuditKind): "default" | "secondary" | "destructive" | "outline" {
  if (kind.includes("error") || kind.includes("deadlettered") || kind.includes("failed"))
    return "destructive"
  if (kind.includes("success") || kind.includes("started") || kind.includes("refreshed"))
    return "default"
  if (kind.includes("tripped") || kind.includes("blocked") || kind.includes("opened"))
    return "outline"
  return "secondary"
}

function kindBadgeClass(kind: AuditKind): string {
  if (kind.includes("tripped") || kind.includes("opened")) {
    return "text-amber-700 bg-amber-100 dark:text-amber-300 dark:bg-amber-900/30"
  }
  return ""
}

function AuditRow({ entry }: { entry: AuditEntry }) {
  const [expanded, setExpanded] = useState(false)
  const hasFields = entry.fields && Object.keys(entry.fields).length > 0

  return (
    <div className="rounded-lg border bg-card text-sm">
      <div
        className={cn("flex items-center gap-2 px-3 py-2", {
          "cursor-pointer hover:bg-muted/50": hasFields,
        })}
        onClick={hasFields ? () => setExpanded((v) => !v) : undefined}
        role={hasFields ? "button" : undefined}
        aria-expanded={hasFields ? expanded : undefined}
        aria-label={hasFields ? `${expanded ? "Collapse" : "Expand"} audit entry` : undefined}
      >
        {hasFields ? (
          expanded ? (
            <ChevronDownIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRightIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          )
        ) : (
          <span className="h-3.5 w-3.5 shrink-0" />
        )}
        <span className="shrink-0 font-mono text-xs text-muted-foreground">
          {new Date(entry.at).toLocaleString()}
        </span>
        <span className="flex-1 truncate text-xs text-muted-foreground">{entry.adapterId}</span>
        <Badge
          variant={kindBadgeVariant(entry.kind)}
          className={cn("shrink-0 text-xs", kindBadgeClass(entry.kind))}
        >
          {entry.kind}
        </Badge>
        {entry.reason && (
          <span className="truncate text-xs text-muted-foreground max-w-[160px]">
            {entry.reason}
          </span>
        )}
      </div>
      {expanded && entry.fields && (
        <div className="border-t bg-muted/30 px-3 py-2">
          <pre className="overflow-x-auto text-xs text-muted-foreground whitespace-pre-wrap">
            {JSON.stringify(entry.fields, null, 2)}
          </pre>
        </div>
      )}
    </div>
  )
}

interface AuditTabProps {
  /** Injected in tests to override initial time range. */
  initialTimeRange?: TimeRange
}

export function AuditTab({ initialTimeRange = "24h" }: AuditTabProps = {}) {
  const [selectedAdapters, setSelectedAdapters] = useState<string[]>([])
  const [selectedKinds, setSelectedKinds] = useState<AuditKind[]>([])
  const [timeRange, setTimeRange] = useState<TimeRange>(initialTimeRange)

  const adapters = useLiveQuery<AdapterInstanceRow[]>(
    () =>
      typeof window === "undefined" ? Promise.resolve([]) : getDb().adapterInstances.toArray(),
    []
  )

  const cutoff = timeRangeToMs(timeRange)

  const auditEntries = useLiveQuery<AuditEntry[]>(() => {
    if (typeof window === "undefined") return Promise.resolve([])
    const cutoffAt = cutoff !== null ? Date.now() - cutoff : null
    let coll = getDb().connectorAudit.orderBy("at").reverse()
    if (cutoffAt !== null) {
      coll = coll.filter((r) => r.at >= cutoffAt)
    }
    return coll.limit(500).toArray()
  }, [cutoff])

  const toggleAdapter = (id: string) => {
    setSelectedAdapters((prev) =>
      prev.includes(id) ? prev.filter((a) => a !== id) : [...prev, id]
    )
  }

  const toggleKind = (kind: AuditKind) => {
    setSelectedKinds((prev) =>
      prev.includes(kind) ? prev.filter((k) => k !== kind) : [...prev, kind]
    )
  }

  const filtered = (auditEntries ?? []).filter((e) => {
    if (selectedAdapters.length > 0 && !selectedAdapters.includes(e.adapterId)) return false
    if (selectedKinds.length > 0 && !selectedKinds.includes(e.kind)) return false
    return true
  })

  return (
    <div className="space-y-4">
      {/* Redaction reminder */}
      <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
        <ShieldIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>Audit logs are allowlist-redacted; tokens and message bodies never appear here.</span>
      </div>

      {/* Adapter filter */}
      {adapters && adapters.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground">Filter by adapter</p>
          <div className="flex flex-wrap gap-1.5">
            {adapters.map((a) => (
              <Toggle
                key={a.id}
                size="sm"
                pressed={selectedAdapters.includes(a.id)}
                onPressedChange={() => toggleAdapter(a.id)}
                aria-label={`Filter by adapter ${a.displayName}`}
              >
                {a.displayName}
              </Toggle>
            ))}
          </div>
        </div>
      )}

      {/* Kind filter */}
      <div className="space-y-1.5">
        <p className="text-xs font-medium text-muted-foreground">Filter by kind</p>
        <div className="flex flex-wrap gap-1.5">
          {ALL_AUDIT_KINDS.map((kind) => (
            <Toggle
              key={kind}
              size="sm"
              pressed={selectedKinds.includes(kind)}
              onPressedChange={() => toggleKind(kind)}
              aria-label={`Filter by ${kind}`}
            >
              {kind}
            </Toggle>
          ))}
        </div>
      </div>

      {/* Time range */}
      <div className="space-y-1.5">
        <p className="text-xs font-medium text-muted-foreground">Time range</p>
        <div className="flex flex-wrap gap-1.5">
          {TIME_RANGE_OPTIONS.map((opt) => (
            <Toggle
              key={opt.value}
              size="sm"
              pressed={timeRange === opt.value}
              onPressedChange={() => setTimeRange(opt.value)}
              aria-label={opt.label}
            >
              {opt.label}
            </Toggle>
          ))}
        </div>
      </div>

      {/* Audit entry list */}
      {filtered.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center">
            <AlertTriangleIcon className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">
              No audit entries match the current filters.
            </p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-1.5">
          {filtered.map((entry) => (
            <AuditRow key={entry.id} entry={entry} />
          ))}
        </div>
      )}
    </div>
  )
}
