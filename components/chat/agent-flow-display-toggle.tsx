"use client"

/**
 * Quick 3-way toggle for the agent invocation-flow display mode, mounted in the
 * chat header. Mirrors the shadcn `ToggleGroup` pattern used by the discover /
 * library view toggles, but is bound to the global `useAgentFlowMode` (so it
 * stays in sync with the appearance settings card and applies everywhere).
 */

import { useTranslations } from "next-intl"
import { LayoutListIcon, ListTreeIcon, Rows3Icon } from "lucide-react"

import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { useAgentFlowMode } from "@/hooks/chat/use-agent-flow-mode"
import { isAgentFlowMode } from "@/types/appearance"

export interface AgentFlowDisplayToggleProps {
  className?: string
}

export function AgentFlowDisplayToggle({ className }: AgentFlowDisplayToggleProps) {
  const t = useTranslations("chat.header.flowDisplay")
  const { mode, setMode } = useAgentFlowMode()

  return (
    <ToggleGroup
      type="single"
      size="sm"
      value={mode}
      onValueChange={(value) => {
        if (isAgentFlowMode(value)) setMode(value)
      }}
      aria-label={t("aria")}
      className={className}
      data-testid="agent-flow-display-toggle"
    >
      <ToggleGroupItem
        value="simplified"
        aria-label={t("simplified")}
        data-testid="agent-flow-simplified"
      >
        <Rows3Icon className="size-3.5" />
      </ToggleGroupItem>
      <ToggleGroupItem
        value="standard"
        aria-label={t("standard")}
        data-testid="agent-flow-standard"
      >
        <LayoutListIcon className="size-3.5" />
      </ToggleGroupItem>
      <ToggleGroupItem
        value="detailed"
        aria-label={t("detailed")}
        data-testid="agent-flow-detailed"
      >
        <ListTreeIcon className="size-3.5" />
      </ToggleGroupItem>
    </ToggleGroup>
  )
}
