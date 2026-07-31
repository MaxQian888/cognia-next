"use client"

/**
 * Tiny dropdown that flips the active agent *runtime* — Claude SDK
 * (cognia-next's bundled sidecar, the default) versus an External Agent
 * (Codex / Claude Code CLI / Gemini CLI / Cursor / any custom command).
 *
 * Sits next to PermissionModeIndicator + WebSearchToggle in the composer
 * toolbar. Pairs with `<AgentModeSelector>` (built-in/custom Agent Modes,
 * orthogonal to runtime) and `<ExternalAgentSelector>` (which external
 * agent record to dispatch to, only shown when runtime === "external").
 */

import { useEffect } from "react"
import { useTranslations } from "next-intl"
import { BotIcon, ChevronDownIcon, PlugZapIcon } from "lucide-react"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { useAgentRuntimeStore, type AgentRuntime } from "@/stores/agent"
import { useExternalAgentStore } from "@/stores/agent/external-agent-store"

interface Props {
  className?: string
  /** Disable the selector externally (e.g. while a turn is streaming). */
  disabled?: boolean
}

// Picks runtime type only (claude-sdk | external). The external-agent
// record itself is selected by the sibling `<ExternalAgentSelector>` in
// the composer toolbar — keeping this widget single-purpose.
export function AgentRuntimeSelector({ className, disabled }: Props) {
  const t = useTranslations("agentRuntime")
  const runtime = useAgentRuntimeStore((s) => s.runtime)
  const setRuntime = useAgentRuntimeStore((s) => s.setRuntime)
  const externalAgentId = useAgentRuntimeStore((s) => s.externalAgentId)
  const externalAgentName = useExternalAgentStore((s) =>
    externalAgentId ? s.agents[externalAgentId]?.name : undefined
  )
  const hasConfiguredExternalAgent = useExternalAgentStore(
    (s) => s.enabled && Object.values(s.agents).some((agent) => agent.enabled)
  )

  // A persisted external runtime can outlive its agent configuration. Keep the
  // execution state valid instead of leaving the composer on an unusable
  // "External (none selected)" lane after the last enabled agent is removed.
  useEffect(() => {
    if (runtime === "external" && !hasConfiguredExternalAgent) {
      setRuntime("claude-sdk")
    }
  }, [hasConfiguredExternalAgent, runtime, setRuntime])

  const Icon = runtime === "external" ? PlugZapIcon : BotIcon
  const label =
    runtime === "external" ? (externalAgentName ?? t("externalUnconfigured")) : t("claudeSdk")

  return (
    <DropdownMenu>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger
            disabled={disabled}
            className={cn(
              "inline-flex h-7 min-w-0 items-center gap-1.5 rounded-lg border border-transparent bg-muted/35 px-2 text-[11px] text-muted-foreground transition-colors hover:border-border/70 hover:bg-muted/70 hover:text-foreground disabled:pointer-events-none disabled:opacity-50",
              className
            )}
            aria-label={t("ariaLabel")}
          >
            <Icon className="size-3.5 shrink-0" />
            <span className="min-w-0 truncate font-medium">{label}</span>
            <ChevronDownIcon className="size-3 shrink-0 opacity-60" />
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="top">{t("tooltip")}</TooltipContent>
      </Tooltip>
      <DropdownMenuContent align="start" sideOffset={8} className="w-72 rounded-xl p-1.5">
        <DropdownMenuLabel>{t("label")}</DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={runtime}
          onValueChange={(value) => {
            if (value === "external" && !hasConfiguredExternalAgent) return
            setRuntime(value as AgentRuntime)
          }}
        >
          <DropdownMenuRadioItem value="claude-sdk">
            <BotIcon className="mr-2 size-4" />
            <div className="flex flex-col">
              <span className="text-sm">{t("claudeSdk")}</span>
              <span className="text-[10px] text-muted-foreground">{t("claudeSdkDesc")}</span>
            </div>
          </DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="external" disabled={!hasConfiguredExternalAgent}>
            <PlugZapIcon className="mr-2 size-4" />
            <div className="flex flex-col">
              <span className="text-sm">{t("external")}</span>
              <span className="text-[10px] text-muted-foreground">
                {hasConfiguredExternalAgent ? t("externalDesc") : t("externalEmpty")}
              </span>
            </div>
          </DropdownMenuRadioItem>
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

export default AgentRuntimeSelector
