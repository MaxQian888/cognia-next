"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import {
  AlertTriangleIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  DownloadIcon,
  ShieldIcon,
} from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Toggle } from "@/components/ui/toggle"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { getDb } from "@/lib/db/schema"
import type { AuditEntry, AuditKind } from "@/types/connectors/audit"
import type { AdapterInstanceRow, ConnectorAuditRow } from "@/lib/db/connector-types"
import { cn } from "@/lib/utils"
import { exportAuditView } from "@/lib/connectors/audit-export"
import { auditKindLabel } from "./audit-kind-label"

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
  "oauth.scope_changed",
  "adapter.started",
  "adapter.stopped",
  "adapter.error",
  // SLA escalation chain (slice 1B).
  "sla.escalated",
  "sla.escalation_action_failed",
]

type TimeRange = "1h" | "24h" | "7d" | "all"

const TIME_RANGE_OPTIONS: TimeRange[] = ["1h", "24h", "7d", "all"]

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
  const t = useTranslations("settings.connections.audit")
  const tKind = useTranslations("settings.connections.audit.kind")
  const [expanded, setExpanded] = useState(false)
  const hasFields = entry.fields && Object.keys(entry.fields).length > 0
  const summary = (
    <>
      {hasFields ? (
        expanded ? (
          <ChevronDownIcon className="size-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground" />
        )
      ) : (
        <span className="size-3.5 shrink-0" />
      )}
      <span className="shrink-0 font-mono text-xs text-muted-foreground">
        {new Date(entry.at).toLocaleString()}
      </span>
      <span className="flex-1 truncate text-xs text-muted-foreground">{entry.adapterId}</span>
      <Badge
        variant={kindBadgeVariant(entry.kind)}
        className={cn("shrink-0 text-xs", kindBadgeClass(entry.kind))}
      >
        {auditKindLabel(tKind, entry.kind)}
      </Badge>
      {entry.reason && (
        <span className="max-w-[160px] truncate text-xs text-muted-foreground">{entry.reason}</span>
      )}
    </>
  )

  return (
    <div className="border-b text-sm last:border-b-0">
      {hasFields ? (
        <Button
          type="button"
          variant="ghost"
          className="h-auto w-full justify-start rounded-none px-3 py-2 font-normal"
          onClick={() => setExpanded((value) => !value)}
          aria-expanded={expanded}
          aria-label={expanded ? t("collapseAria") : t("expandAria")}
        >
          {summary}
        </Button>
      ) : (
        <div className="flex items-center gap-2 px-3 py-2">{summary}</div>
      )}
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
  /**
   * When supplied (im-refactored-crayon), scopes the view to a single
   * adapter and hides the adapter-filter chip row. Used by the per-adapter
   * detail panel's Audit tab to avoid duplicating the entire component.
   */
  adapterId?: string
}

export function AuditTab({ initialTimeRange = "24h", adapterId }: AuditTabProps = {}) {
  const t = useTranslations("settings.connections.audit")
  const tKind = useTranslations("settings.connections.audit.kind")
  const [selectedAdapters, setSelectedAdapters] = useState<string[]>(adapterId ? [adapterId] : [])
  const [selectedKinds, setSelectedKinds] = useState<AuditKind[]>([])
  const [timeRange, setTimeRange] = useState<TimeRange>(initialTimeRange)
  const [conversationKeyFilter, setConversationKeyFilter] = useState<string>("")

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

  const trimmedConversationKey = conversationKeyFilter.trim().toLowerCase()
  const filtered = (auditEntries ?? []).filter((e) => {
    if (selectedAdapters.length > 0 && !selectedAdapters.includes(e.adapterId)) return false
    if (selectedKinds.length > 0) {
      if (!selectedKinds.includes(e.kind)) return false
    } else {
      // Default view excludes `adapter.heartbeat`. As of v51 heartbeats live
      // in their own `connectorHeartbeats` table and no longer land here, so
      // this now only hides legacy heartbeat rows written to `connectorAudit`
      // before the migration (they age out under the 5 000-row cap). The
      // guard is cheap and also catches any future "noisy by default" kinds.
      if (e.kind === "adapter.heartbeat") return false
    }
    if (trimmedConversationKey) {
      const key = e.conversationKey?.toLowerCase() ?? ""
      if (!key.includes(trimmedConversationKey)) return false
    }
    return true
  })

  const exportScope = adapterId ?? (selectedAdapters.length === 1 ? selectedAdapters[0] : null)
  const handleExport = (format: "csv" | "json") => {
    exportAuditView({
      rows: filtered as ConnectorAuditRow[],
      format,
      adapterId: exportScope,
    })
  }

  return (
    <div className="space-y-4">
      {/* Redaction reminder */}
      <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-300">
        <ShieldIcon className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>{t("redactionNotice")}</span>
      </div>

      {/* Adapter filter — hidden when the parent has already scoped us
       * to a single adapter via the `adapterId` prop. */}
      {!adapterId && adapters && adapters.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-xs font-medium text-muted-foreground">{t("filterByAdapter")}</p>
          <div className="flex flex-wrap gap-1.5">
            {adapters.map((a) => (
              <Toggle
                key={a.id}
                size="sm"
                pressed={selectedAdapters.includes(a.id)}
                onPressedChange={() => toggleAdapter(a.id)}
                aria-label={t("filterByAdapterAria", { name: a.displayName })}
              >
                {a.displayName}
              </Toggle>
            ))}
          </div>
        </div>
      )}

      {/* Kind filter */}
      <div className="space-y-1.5">
        <p className="text-xs font-medium text-muted-foreground">{t("filterByKind")}</p>
        <div className="flex flex-wrap gap-1.5">
          {ALL_AUDIT_KINDS.map((kind) => {
            const kindLabel = auditKindLabel(tKind, kind)
            return (
              <Toggle
                key={kind}
                size="sm"
                pressed={selectedKinds.includes(kind)}
                onPressedChange={() => toggleKind(kind)}
                aria-label={t("filterByKindAria", { kind: kindLabel })}
              >
                {kindLabel}
              </Toggle>
            )
          })}
        </div>
      </div>

      {/* Time range */}
      <div className="space-y-1.5">
        <p className="text-xs font-medium text-muted-foreground">{t("timeRangeLabel")}</p>
        <div className="flex flex-wrap gap-1.5">
          {TIME_RANGE_OPTIONS.map((value) => {
            const label = t(`timeRange.${value}`)
            return (
              <Toggle
                key={value}
                size="sm"
                pressed={timeRange === value}
                onPressedChange={() => setTimeRange(value)}
                aria-label={label}
              >
                {label}
              </Toggle>
            )
          })}
        </div>
      </div>

      {/* Conversation-key filter + Export menu */}
      <div className="flex flex-wrap items-end gap-2">
        <div className="flex-1 min-w-[180px] space-y-1.5">
          <Label htmlFor="audit-conv-key" className="text-xs font-medium text-muted-foreground">
            {t("filterByConversationKey")}
          </Label>
          <Input
            id="audit-conv-key"
            type="text"
            value={conversationKeyFilter}
            onChange={(e) => setConversationKeyFilter(e.target.value)}
            placeholder={t("filterByConversationKeyPlaceholder")}
            aria-label={t("filterByConversationKey")}
            data-testid="audit-conv-key-input"
            className="h-9 text-xs"
          />
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={filtered.length === 0}
              data-testid="audit-export-trigger"
            >
              <DownloadIcon className="mr-1.5 h-3.5 w-3.5" />
              {t("exportLabel", { count: filtered.length })}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => handleExport("csv")} data-testid="audit-export-csv">
              {t("exportCsv")}
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => handleExport("json")} data-testid="audit-export-json">
              {t("exportJson")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Audit entry list */}
      {filtered.length === 0 ? (
        <Card>
          <CardContent className="py-8 text-center">
            <AlertTriangleIcon className="mx-auto mb-3 h-8 w-8 text-muted-foreground" />
            <p className="text-sm text-muted-foreground">{t("empty")}</p>
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
