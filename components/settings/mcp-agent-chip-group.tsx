"use client"

// Per-server row of agent chips. Each chip represents one external coding
// agent (Claude Code, Cursor, …). State is four-way:
//   - "missing"  → file path doesn't exist; chip is greyed and inert.
//   - "off"      → file exists, server NOT projected here. Click to enable.
//   - "on"       → server is projected here. Click to disable.
//   - "readonly" → adapter doesn't write (cline, roo-code). Inert.
//
// On click, we patch `appsEnabled[agentId]` via `updateMcpServer` and the
// CRUD layer schedules a debounced sync to the agent's file.

import { Loader2Icon } from "lucide-react"
import { useState } from "react"
import { toast } from "sonner"
import { useTranslations } from "next-intl"

import { cn } from "@/lib/utils"
import { isTauri } from "@/lib/tauri"
import { updateMcpServer } from "@/lib/db/mcp-servers"
import type { McpServer } from "@/lib/claude/types"
import { useAgentStatuses, type AgentStatus } from "@/hooks/agent"

// Re-export for back-compat with callers.
export { refreshAgentStatuses as refreshAgentAvailability } from "@/hooks/agent"

interface AgentChipGroupProps {
  server: McpServer
}

export function McpAgentChipGroup({ server }: AgentChipGroupProps) {
  const t = useTranslations("mcp.chips")
  const { statuses, loading } = useAgentStatuses()
  return (
    <div className="flex flex-wrap items-center gap-1">
      <span className="mr-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
        {t("label")}
      </span>
      {statuses.map((status) => (
        <AgentChip key={status.agent.id} status={status} server={server} loading={loading} />
      ))}
    </div>
  )
}

interface AgentChipProps {
  status: AgentStatus
  server: McpServer
  loading: boolean
}

function AgentChip({ status, server, loading }: AgentChipProps) {
  const t = useTranslations("mcp.chips")
  const { agent } = status
  const projected = server.appsEnabled?.[agent.id] === true
  const [busy, setBusy] = useState(false)

  const inert = !agent.writable || !isTauri() || !status.exists || loading

  const onClick = async () => {
    if (busy || inert) return
    setBusy(true)
    try {
      const next = { ...(server.appsEnabled ?? {}), [agent.id]: !projected }
      await updateMcpServer(server.id, { appsEnabled: next })
      toast.success(
        projected
          ? t("removingToast", { agent: agent.displayName, name: server.name })
          : t("addingToast", { agent: agent.displayName, name: server.name })
      )
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const tooltip = !agent.writable
    ? t("tooltipReadOnly", { name: agent.displayName })
    : !status.exists
      ? t("tooltipMissing", { name: agent.displayName })
      : !isTauri()
        ? t("tooltipDesktopOnly", { name: agent.displayName })
        : projected
          ? t("tooltipRemove", { name: agent.displayName })
          : t("tooltipAdd", { name: agent.displayName })

  return (
    <button
      type="button"
      onClick={() => void onClick()}
      disabled={inert || busy}
      title={tooltip}
      aria-pressed={projected}
      className={cn(
        "inline-flex h-5 items-center gap-1 rounded-full border px-2 text-[10px] font-medium transition-colors",
        projected
          ? "border-primary/40 bg-primary text-primary-foreground hover:bg-primary/90"
          : "border-border bg-transparent text-muted-foreground",
        !inert && !projected && "hover:border-primary/40 hover:bg-accent hover:text-foreground",
        (loading || (!status.exists && agent.writable)) && "opacity-40",
        !agent.writable && "border-dashed",
        busy && "cursor-progress"
      )}
    >
      {busy && <Loader2Icon className="size-2.5 animate-spin" />}
      {agent.displayName}
    </button>
  )
}
