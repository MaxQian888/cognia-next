"use client"

import { useTranslations } from "next-intl"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"
import { PowerIcon, RefreshCwIcon, Trash2Icon, XIcon } from "lucide-react"
import { toast } from "sonner"

import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import { deleteMcpServer, updateMcpServer } from "@/lib/db/mcp-servers"
import { useMcpPanelStore } from "@/stores/mcp/mcp-panel-store"
import { MOBILE_DURATION, MOBILE_EASE } from "@/lib/ui/motion"
import { loggers } from "@cognia/logging"
import type { AgentId, McpServer } from "@cognia/agent-config-types"

interface Props {
  /** Full server list; the bar operates on the subset in `selection`. */
  servers: McpServer[]
}

/**
 * Floating action bar shown when one or more servers are selected. Batch
 * enable / disable / re-sync / delete, each looping the existing single-row
 * CRUD so the agent-projection side effects stay identical to one-off edits.
 */
export function McpBatchActionsBar({ servers }: Props) {
  const t = useTranslations("mcp.batch")
  const selection = useMcpPanelStore((s) => s.selection)
  const clear = useMcpPanelStore((s) => s.clearSelection)
  const reduce = useReducedMotion()
  const count = selection.size

  const selected = servers.filter((s) => selection.has(s.id))

  const setEnabled = async (enabled: boolean) => {
    let failed = 0
    for (const s of selected) {
      try {
        await updateMcpServer(s.id, { enabled })
      } catch (err) {
        failed += 1
        loggers.mcp.error("batch toggle failed", err, { id: s.id, enabled })
      }
    }
    toast.success(t(enabled ? "enabledCount" : "disabledCount", { count: count - failed }))
    clear()
  }

  const handleDelete = async () => {
    let failed = 0
    for (const s of selected) {
      try {
        await deleteMcpServer(s.id)
      } catch (err) {
        failed += 1
        loggers.mcp.warn("batch delete skipped", { id: s.id, error: String(err) })
      }
    }
    if (failed > 0) toast.warning(t("deletedPartial", { ok: count - failed, total: count }))
    else toast.success(t("deletedCount", { count }))
    clear()
  }

  const handleSync = async () => {
    // Collect the union of agents the selected servers project to, then
    // persist one coalesced coordinator request for the affected agents.
    const agents = new Set<AgentId>()
    for (const s of selected) {
      for (const [agentId, on] of Object.entries(s.appsEnabled ?? {})) {
        if (on) agents.add(agentId as AgentId)
      }
    }
    if (agents.size > 0) {
      try {
        const { requestMcpSync } = await import("@/lib/mcp/sync-coordinator")
        await requestMcpSync(agents)
      } catch (err) {
        loggers.mcp.error("batch sync failed", err)
      }
    }
    toast.success(t("syncedCount", { count }))
    clear()
  }

  return (
    <AnimatePresence>
      {count > 0 && (
        <motion.div
          key="mcp-batch-bar"
          initial={reduce ? false : { opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          exit={reduce ? undefined : { opacity: 0, y: 24 }}
          transition={
            reduce ? { duration: 0 } : { duration: MOBILE_DURATION.normal, ease: MOBILE_EASE }
          }
          className="pointer-events-none fixed bottom-4 left-1/2 z-30 -translate-x-1/2"
        >
          <Card
            className="pointer-events-auto flex max-w-[calc(100vw-2rem)] flex-wrap items-center gap-1.5 px-3 py-2 shadow-lg"
            data-testid="mcp-batch-actions-bar"
          >
            <span className="text-xs font-medium">{t("selectedCount", { count })}</span>
            <span className="hidden h-4 w-px bg-border sm:inline-block" />
            <Button size="sm" variant="ghost" onClick={() => void setEnabled(true)}>
              <PowerIcon className="size-3.5 sm:mr-1.5" />
              <span className="hidden sm:inline">{t("enable")}</span>
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void setEnabled(false)}>
              <PowerIcon className="size-3.5 rotate-180 sm:mr-1.5" />
              <span className="hidden sm:inline">{t("disable")}</span>
            </Button>
            <Button size="sm" variant="ghost" onClick={() => void handleSync()}>
              <RefreshCwIcon className="size-3.5 sm:mr-1.5" />
              <span className="hidden sm:inline">{t("sync")}</span>
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void handleDelete()}
              className="text-destructive hover:text-destructive"
            >
              <Trash2Icon className="size-3.5 sm:mr-1.5" />
              <span className="hidden sm:inline">{t("delete")}</span>
            </Button>
            <span className="hidden h-4 w-px bg-border sm:inline-block" />
            <Button
              size="icon"
              variant="ghost"
              onClick={clear}
              className="size-7"
              aria-label={t("clear")}
            >
              <XIcon className="size-3.5" />
            </Button>
          </Card>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
