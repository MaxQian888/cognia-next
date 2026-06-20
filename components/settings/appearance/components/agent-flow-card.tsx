"use client"

// Agent invocation-flow display mode — simplified / standard / detailed.
// Reads/writes the global `settings.agentFlowMode` via `useAgentFlowMode`,
// the same value the chat-header quick toggle drives.

import { useTranslations } from "next-intl"

import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { useAgentFlowMode } from "@/hooks/chat/use-agent-flow-mode"
import { AGENT_FLOW_MODES, type AgentFlowMode } from "@/types/appearance"

export function AgentFlowCard() {
  const t = useTranslations("settings.appearance.agentFlow")
  const { mode, setMode } = useAgentFlowMode()

  return (
    <div className="space-y-2">
      <Label className="text-xs">{t("label")}</Label>
      <Select value={mode} onValueChange={(value) => setMode(value as AgentFlowMode)}>
        <SelectTrigger className="w-full max-w-xs" data-testid="agent-flow-mode-select">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {AGENT_FLOW_MODES.map((m) => (
            <SelectItem key={m} value={m}>
              {t(`mode.${m}`)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <p className="text-[11px] text-muted-foreground">{t(`hint.${mode}`)}</p>
    </div>
  )
}
