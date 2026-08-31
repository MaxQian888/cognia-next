"use client"

// Top-level agent status row inside the MCP settings panel. For each known
// agent: file path, in-file count, projected-to-cognia count, and a
// per-agent "Sync now" button. Read-only agents (cline, roo-code) display
// the same info but the sync button is disabled.
//
// Layout pattern: dense table-ish list, each row click-targets the sync.

import {
  AlertTriangleIcon,
  CheckCircle2Icon,
  FolderXIcon,
  Loader2Icon,
  RefreshCwIcon,
} from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { SurfaceUnavailableNotice } from "@/components/platform/surface-unavailable-notice"
import { useSurfaceReach } from "@/hooks/platform/use-surface-reach"
import { cn } from "@/lib/utils"
import { syncToAgent, type SyncResult } from "@/lib/claude/sync"
import { useAgentStatuses, type AgentStatus } from "@/hooks/agent"
import type { AgentId } from "@cognia/agent-config-types"

export function McpAgentStatusBar() {
  const t = useTranslations("mcp.agents")
  const { statuses, projectedCount, refresh, loading } = useAgentStatuses()
  const [syncingAll, setSyncingAll] = useState(false)
  const [busy, setBusy] = useState<Set<AgentId>>(new Set())
  // Writes `~/.claude/…`, `~/.codex/…` and friends on the machine the user is
  // sitting at, so this needs the desktop process itself rather than any host
  // that happens to have a shell. `requirement: "desktop-shell"` is what says
  // so, and it is why a paired companion gets an explanation rather than a
  // control that would write to the wrong machine.
  const reach = useSurfaceReach({ capability: "shell", requirement: "desktop-shell" })

  if (!reach.available) {
    // This bar IS the Agents tab. Returning null left the tab with nothing but
    // a related-links strip and no hint that agent sync exists at all, which
    // is the shape of "hiding collapses three answers into one silence".
    return <SurfaceUnavailableNotice reach={reach} data-testid="mcp-agents-unavailable" />
  }

  const writable = statuses.filter((s) => s.agent.writable)
  const readonly = statuses.filter((s) => !s.agent.writable)

  const onSyncOne = async (agentId: AgentId) => {
    setBusy((b) => new Set(b).add(agentId))
    try {
      const r = await syncToAgent(agentId)
      announce(t, agentId, r)
      refresh()
    } finally {
      setBusy((b) => {
        const n = new Set(b)
        n.delete(agentId)
        return n
      })
    }
  }

  const onSyncAll = async () => {
    setSyncingAll(true)
    try {
      const results: Record<string, SyncResult> = {}
      await Promise.all(
        writable
          .filter((s) => s.exists)
          .map(async (s) => {
            results[s.agent.id] = await syncToAgent(s.agent.id)
          })
      )
      const synced = Object.values(results).filter((r) => r.ok).length
      const errors = Object.values(results).filter(
        (r) => !r.ok && !("skipped" in r && r.skipped)
      ).length
      toast.success(
        errors > 0
          ? t("syncedSummaryWithErrors", { synced, errors })
          : t("syncedSummary", { synced })
      )
      refresh()
    } finally {
      setSyncingAll(false)
    }
  }

  return (
    <div data-testid="mcp-agent-status-bar" className="space-y-2 rounded-md border bg-muted/20 p-3">
      <div className="flex items-center justify-between">
        <div className="space-y-0.5">
          <p className="text-xs font-medium">{t("title")}</p>
          <p className="text-[11px] text-muted-foreground">{t("subtitle")}</p>
        </div>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-2 text-xs"
          onClick={() => void onSyncAll()}
          disabled={syncingAll || loading}
          title={t("syncAllTitle")}
        >
          {syncingAll ? (
            <Loader2Icon className="mr-1.5 size-3.5 animate-spin" />
          ) : (
            <RefreshCwIcon className="mr-1.5 size-3.5" />
          )}
          {t("syncAll")}
        </Button>
      </div>

      <div className="divide-y rounded border bg-background">
        {writable.map((status) => (
          <AgentRow
            key={status.agent.id}
            status={status}
            projected={projectedCount[status.agent.id] ?? 0}
            busy={busy.has(status.agent.id)}
            onSync={() => void onSyncOne(status.agent.id)}
          />
        ))}
        {readonly.map((status) => (
          <AgentRow
            key={status.agent.id}
            status={status}
            projected={projectedCount[status.agent.id] ?? 0}
            busy={false}
            readOnly
          />
        ))}
      </div>
    </div>
  )
}

interface AgentRowProps {
  status: AgentStatus
  projected: number
  busy: boolean
  readOnly?: boolean
  onSync?: () => void
}

function AgentRow({ status, projected, busy, readOnly, onSync }: AgentRowProps) {
  const t = useTranslations("mcp.agents")
  const { agent, path, exists, parseError, inFileCount } = status
  const drift = exists && projected !== inFileCount

  return (
    <div className="flex items-center gap-3 px-3 py-2 text-xs">
      <div className="flex size-6 shrink-0 items-center justify-center rounded">
        {parseError ? (
          <AlertTriangleIcon className="size-4 text-amber-500" />
        ) : exists ? (
          <CheckCircle2Icon className="size-4 text-emerald-600" />
        ) : (
          <FolderXIcon className="size-4 text-muted-foreground" />
        )}
      </div>
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex items-center gap-2">
          <span className="font-medium">{agent.displayName}</span>
          {readOnly && (
            <span className="rounded border border-dashed px-1 py-0 text-[9px] uppercase tracking-wider text-muted-foreground">
              {t("readOnly")}
            </span>
          )}
          <span className={cn("text-[10px]", drift ? "text-amber-600" : "text-muted-foreground")}>
            {!exists ? t("notDetected") : t("projectedInFile", { projected, inFile: inFileCount })}
          </span>
        </div>
        {path && <p className="truncate font-mono text-[10px] text-muted-foreground">{path}</p>}
        {parseError && (
          <p className="text-[10px] text-amber-700 dark:text-amber-300">
            {t("parseError", { error: parseError })}
          </p>
        )}
      </div>
      {!readOnly && (
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-2 text-[11px]"
          onClick={onSync}
          disabled={!exists || busy || !!parseError}
          title={
            parseError
              ? t("syncTooltipParseError")
              : exists
                ? t("syncTooltipExists", { name: agent.displayName })
                : t("syncTooltipMissing", { name: agent.displayName })
          }
        >
          {busy ? (
            <Loader2Icon className="size-3.5 animate-spin" />
          ) : (
            <RefreshCwIcon className="size-3.5" />
          )}
        </Button>
      )}
    </div>
  )
}

function announce(t: ReturnType<typeof useTranslations>, agentId: AgentId, r: SyncResult): void {
  if (r.ok) {
    toast.success(t("syncedOk", { agent: agentId, count: r.count }))
    return
  }
  if (r.skipped) {
    if (r.reason === "agent-not-installed") {
      toast.message(t("syncSkippedNotInstalled", { agent: agentId }))
    } else if (r.reason === "no-path-on-os") {
      toast.message(t("syncSkippedUnsupported", { agent: agentId }))
    } else if (r.reason === "read-only") {
      toast.message(t("syncSkippedReadOnly", { agent: agentId }))
    } else {
      toast.message(t("syncSkippedGeneric", { agent: agentId, reason: r.reason }))
    }
    return
  }
  toast.error(t("syncFailed", { agent: agentId, error: r.error }))
}
