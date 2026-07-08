"use client"

/**
 * AgentBadge — compact colored chip naming the agent behind a fleet row
 * (Claude Code / Codex / OpenCode). Product names come from i18n like every
 * other user-facing string (`fleet.agents.*`).
 */

import { useTranslations } from "next-intl"
import { cn } from "@/lib/utils"
import type { FleetAgent } from "@/lib/fleet/types"

const AGENT_STYLES: Record<FleetAgent, string> = {
  "claude-code": "bg-orange-500/20 text-orange-300 border-orange-400/30",
  codex: "bg-sky-500/20 text-sky-300 border-sky-400/30",
  opencode: "bg-emerald-500/20 text-emerald-300 border-emerald-400/30",
}

export function AgentBadge({ agent, className }: { agent: FleetAgent; className?: string }) {
  const t = useTranslations("fleet.agents")
  return (
    <span
      data-testid={`agent-badge-${agent}`}
      className={cn(
        "inline-flex shrink-0 items-center rounded-md border px-1.5 py-0.5 text-[10px] font-semibold leading-none",
        AGENT_STYLES[agent],
        className
      )}
    >
      {t(agent)}
    </span>
  )
}

export default AgentBadge
