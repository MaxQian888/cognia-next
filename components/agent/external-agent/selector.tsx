"use client"

/**
 * ExternalAgentSelector - Select and manage external agents in agent mode
 * Integrates with the external agent store for configuration and connection management
 */

import { useState, useMemo, useCallback, useEffect, useReducer } from "react"
import { useTranslations } from "next-intl"
import {
  ExternalLink,
  Plug,
  PlugZap,
  Settings,
  ChevronDown,
  Check,
  AlertCircle,
  Loader2,
  Power,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuGroup,
  DropdownMenuLabel,
} from "@/components/ui/dropdown-menu"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import { ExternalAgentManager } from "./manager"
import { ConnectionStatusBadge } from "./connection-status-badge"
import { useExternalAgentStore } from "@/stores/agent/external-agent-store"
import type { ExternalAgentConnectionStatus } from "@/types/agent/external-agent"
import { getExternalAgentExecutionBlockReason } from "@/lib/ai/agent/external/config-normalizer"
import { onProtocolAdapterRegistryChange } from "@/lib/ai/agent/external/protocol-adapter"

// =============================================================================
// Types
// =============================================================================

interface ExternalAgentSelectorProps {
  /** Currently selected external agent ID (null = use built-in agent) */
  selectedAgentId: string | null
  /** Callback when external agent selection changes */
  onAgentChange: (agentId: string | null) => void
  /** Callback to open settings */
  onOpenSettings?: () => void
  /** Whether the selector is disabled */
  disabled?: boolean
  /** Additional class name */
  className?: string
}

// =============================================================================
// Connection Status Indicator
// =============================================================================

function ConnectionStatusIcon({ status }: { status: ExternalAgentConnectionStatus }) {
  switch (status) {
    case "connected":
      return <PlugZap className="h-3 w-3 text-green-500" />
    case "connecting":
    case "reconnecting":
      return <Loader2 className="h-3 w-3 text-yellow-500 animate-spin" />
    case "error":
      return <AlertCircle className="h-3 w-3 text-destructive" />
    default:
      return <Plug className="h-3 w-3 text-muted-foreground" />
  }
}

// =============================================================================
// Main Component
// =============================================================================

export function ExternalAgentSelector({
  selectedAgentId,
  onAgentChange,
  onOpenSettings,
  disabled,
  className,
}: ExternalAgentSelectorProps) {
  const t = useTranslations("externalAgent")
  const [manageDialogOpen, setManageDialogOpen] = useState(false)

  // Store
  const {
    getAllAgents,
    getConnectionStatus,
    enabled: externalAgentsEnabled,
  } = useExternalAgentStore()

  // Re-render when a plugin enables/disables its external-agent adapter so a
  // plugin-provided agent's blocked reason updates live — the registry is not
  // reactive, so without this the row would stay stale until the next store
  // change.
  const [, refreshOnRegistryChange] = useReducer((tick: number) => tick + 1, 0)
  useEffect(() => onProtocolAdapterRegistryChange(() => refreshOnRegistryChange()), [])

  // Get all configured agents
  const agents = useMemo(() => getAllAgents(), [getAllAgents])

  // Find selected agent
  const selectedAgent = useMemo(() => {
    if (!selectedAgentId) return null
    return agents.find((a) => a.id === selectedAgentId) || null
  }, [selectedAgentId, agents])

  // Handle agent selection
  const handleAgentSelect = useCallback(
    (agentId: string | null) => {
      onAgentChange(agentId)
    },
    [onAgentChange]
  )

  // If external agents are disabled, show disabled state
  if (!externalAgentsEnabled) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            disabled
            className={cn("gap-2 opacity-50", className)}
          >
            <ExternalLink className="h-4 w-4" />
            <span className="hidden sm:inline">{t("disabled")}</span>
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          <p>{t("enableInSettings")}</p>
        </TooltipContent>
      </Tooltip>
    )
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          disabled={disabled}
          className={cn("gap-2", selectedAgent && "border-primary/50", className)}
        >
          {selectedAgent ? (
            <>
              <ConnectionStatusIcon status={getConnectionStatus(selectedAgent.id)} />
              <span className="hidden sm:inline max-w-[140px] truncate">{selectedAgent.name}</span>
            </>
          ) : (
            <>
              <ExternalLink className="h-4 w-4" />
              <span className="hidden sm:inline">{t("builtIn")}</span>
            </>
          )}
          <ChevronDown className="h-3 w-3 opacity-50" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="center" className="w-[calc(100vw-2rem)] max-w-80">
        <DropdownMenuLabel className="text-xs text-muted-foreground">
          {t("selectAgent")}
        </DropdownMenuLabel>
        <DropdownMenuSeparator />

        {/* Built-in Agent Option */}
        <DropdownMenuItem
          onClick={() => handleAgentSelect(null)}
          className="flex items-center gap-2 p-2"
        >
          <div
            className={cn(
              "flex h-6 w-6 shrink-0 items-center justify-center rounded-md",
              !selectedAgentId ? "bg-primary text-primary-foreground" : "bg-muted"
            )}
          >
            <Power className="h-3.5 w-3.5" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="truncate font-medium text-sm">{t("builtInAgent")}</span>
              {!selectedAgentId && <Check className="h-3 w-3 shrink-0 text-primary" />}
            </div>
            <p className="truncate text-xs text-muted-foreground">{t("builtInAgentDesc")}</p>
          </div>
        </DropdownMenuItem>

        {/* External Agents */}
        {agents.length > 0 && (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuLabel className="text-xs text-muted-foreground">
                {t("externalAgents")}
              </DropdownMenuLabel>
              <ScrollArea className="max-h-[180px] sm:max-h-[240px]">
                {agents.map((agent) => {
                  const status = getConnectionStatus(agent.id)
                  const isSelected = agent.id === selectedAgentId
                  const executionBlockedReason = getExternalAgentExecutionBlockReason(agent)
                  return (
                    <DropdownMenuItem
                      key={agent.id}
                      onClick={() => handleAgentSelect(agent.id)}
                      className="flex items-center gap-2 p-2"
                      disabled={!!executionBlockedReason}
                    >
                      <div
                        className={cn(
                          "flex h-6 w-6 shrink-0 items-center justify-center rounded-md",
                          isSelected ? "bg-primary text-primary-foreground" : "bg-muted"
                        )}
                      >
                        <ConnectionStatusIcon status={status} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2">
                          <span className="truncate font-medium text-sm">{agent.name}</span>
                          {isSelected && <Check className="h-3 w-3 shrink-0 text-primary" />}
                        </div>
                        <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
                          <Badge variant="outline" className="text-[10px] h-4 px-1">
                            {agent.protocol.toUpperCase()}
                          </Badge>
                          {executionBlockedReason && (
                            <Badge variant="destructive" className="text-[10px] h-4 px-1">
                              {agent.protocol.includes(":")
                                ? t("selectorPluginUnavailable")
                                : t("selectorComingSoon")}
                            </Badge>
                          )}
                          <ConnectionStatusBadge
                            status={status}
                            className="text-[10px] h-4 px-1.5"
                          />
                        </div>
                        {executionBlockedReason && (
                          <p className="mt-1 line-clamp-2 text-[10px] text-amber-600 dark:text-amber-400">
                            {executionBlockedReason}
                          </p>
                        )}
                      </div>
                    </DropdownMenuItem>
                  )
                })}
              </ScrollArea>
            </DropdownMenuGroup>
          </>
        )}

        {/* Actions */}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => setManageDialogOpen(true)} className="gap-2">
          <Plug className="h-4 w-4" />
          {t("manage")}
        </DropdownMenuItem>
        {onOpenSettings && (
          <DropdownMenuItem onClick={onOpenSettings} className="gap-2">
            <Settings className="h-4 w-4" />
            {t("manageAgents")}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>

      {/* External Agent Manager Dialog */}
      <Dialog open={manageDialogOpen} onOpenChange={setManageDialogOpen}>
        <DialogContent className="flex max-h-[85vh] flex-col overflow-hidden sm:max-w-3xl">
          <DialogHeader className="shrink-0">
            <DialogTitle>{t("manageAgents")}</DialogTitle>
          </DialogHeader>
          <ExternalAgentManager className="min-h-0 flex-1" />
        </DialogContent>
      </Dialog>
    </DropdownMenu>
  )
}
