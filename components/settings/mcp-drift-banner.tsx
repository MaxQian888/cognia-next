"use client"

// Detect when Cognia's projection of a server doesn't match what's actually
// in an external agent's config file. Two flavors of drift surface here:
//
//   - "missing": a server is `appsEnabled[agent]=true` in Dexie but absent
//     from the file. Either the user edited the file by hand, or our last
//     sync silently failed. One-click "Re-sync" calls syncToAgent().
//   - "unmanaged" (informational only): the file contains entries Cognia
//     doesn't know about. We surface counts in a separate "Found X unmanaged"
//     line and offer "Import" which opens the existing import dialog.
//
// The banner is dismissible per-agent within the same session; we never
// auto-overwrite anything — every action that mutates a file requires a
// click here.

import { useState } from "react"
import { toast } from "sonner"
import { useTranslations } from "next-intl"
import {
  AlertTriangleIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  Loader2Icon,
  RefreshCwIcon,
  XIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { isTauri } from "@/lib/tauri"
import { syncToAgent } from "@/lib/claude/sync"
import { useAgentStatuses } from "@/hooks/use-agent-status"
import type { AgentId } from "@/lib/claude/types"
import { cn } from "@/lib/utils"

export function McpDriftBanner() {
  const t = useTranslations("mcp.drift")
  const tAgents = useTranslations("mcp.agents")
  const { statuses, drift, refresh } = useAgentStatuses()
  const [dismissed, setDismissed] = useState<Set<AgentId>>(new Set())
  const [busy, setBusy] = useState<Set<AgentId>>(new Set())
  const [expanded, setExpanded] = useState<Set<AgentId>>(new Set())

  if (!isTauri()) return null

  const drifters = statuses.filter((s) => {
    if (!s.agent.writable || !s.exists || s.parseError) return false
    if (dismissed.has(s.agent.id)) return false
    const d = drift[s.agent.id]
    return d != null && d.missing.length > 0
  })

  if (drifters.length === 0) return null

  const onResync = async (agentId: AgentId) => {
    setBusy((b) => new Set(b).add(agentId))
    try {
      const r = await syncToAgent(agentId)
      if (r.ok) {
        toast.success(t("resyncSuccess", { agent: agentId, count: r.count }))
      } else if ("skipped" in r && r.skipped) {
        toast.message(tAgents("syncSkippedGeneric", { agent: agentId, reason: r.reason }))
      } else if ("error" in r) {
        toast.error(tAgents("syncFailed", { agent: agentId, error: r.error }))
      }
      refresh()
    } finally {
      setBusy((b) => {
        const n = new Set(b)
        n.delete(agentId)
        return n
      })
    }
  }

  const toggleExpand = (id: AgentId) => {
    setExpanded((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })
  }

  return (
    <div className="space-y-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-amber-900 dark:text-amber-100">
      <div className="flex items-center gap-2 text-xs font-medium">
        <AlertTriangleIcon className="size-4" />
        {t("title")}
      </div>
      <p className="text-[11px] text-amber-800/80 dark:text-amber-100/80">{t("subtitle")}</p>
      <div className="space-y-1">
        {drifters.map((status) => {
          const d = drift[status.agent.id]!
          const isOpen = expanded.has(status.agent.id)
          const isBusy = busy.has(status.agent.id)
          return (
            <div
              key={status.agent.id}
              className="rounded border border-amber-500/30 bg-background/60 px-2.5 py-1.5"
            >
              <div className="flex items-center gap-2 text-xs">
                <button
                  type="button"
                  className={cn("inline-flex items-center gap-1 hover:underline")}
                  onClick={() => toggleExpand(status.agent.id)}
                  aria-expanded={isOpen}
                >
                  {isOpen ? (
                    <ChevronDownIcon className="size-3" />
                  ) : (
                    <ChevronRightIcon className="size-3" />
                  )}
                  <span className="font-medium">{status.agent.displayName}</span>
                </button>
                <span className="text-[10px] text-muted-foreground">
                  {t("missingCount", { count: d.missing.length })}
                  {d.unmanaged.length > 0 &&
                    ` · ${t("unmanagedCount", { count: d.unmanaged.length })}`}
                </span>
                <div className="flex-1" />
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 text-[11px]"
                  onClick={() => void onResync(status.agent.id)}
                  disabled={isBusy}
                >
                  {isBusy ? (
                    <Loader2Icon className="mr-1 size-3 animate-spin" />
                  ) : (
                    <RefreshCwIcon className="mr-1 size-3" />
                  )}
                  {t("resync")}
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-6"
                  onClick={() => setDismissed((s) => new Set(s).add(status.agent.id))}
                  title={t("dismiss")}
                >
                  <XIcon className="size-3" />
                </Button>
              </div>
              {isOpen && (
                <div className="mt-1.5 space-y-1 pl-4 text-[11px]">
                  {d.missing.length > 0 && (
                    <div>
                      <span className="text-amber-800/80 dark:text-amber-100/80">
                        {t("missingHeading")}
                      </span>
                      <span className="ml-1 font-mono">{d.missing.join(", ")}</span>
                    </div>
                  )}
                  {d.unmanaged.length > 0 && (
                    <div>
                      <span className="text-muted-foreground">{t("unmanagedHeading")}</span>
                      <span className="ml-1 font-mono text-muted-foreground">
                        {d.unmanaged.join(", ")}
                      </span>
                    </div>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
