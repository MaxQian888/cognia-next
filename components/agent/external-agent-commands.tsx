"use client"

/**
 * External Agent Commands Component
 *
 * Displays available slash commands from ACP agents.
 * @see https://agentclientprotocol.com/protocol/slash-commands
 */

import { useState } from "react"
import { Command, ChevronRight, Terminal } from "lucide-react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import type { AcpAvailableCommand } from "@/types/agent/external-agent"

// ============================================================================
// Types
// ============================================================================

export interface ExternalAgentCommandsProps {
  /** Available commands from the agent */
  commands: AcpAvailableCommand[]
  /** Callback when a command is executed */
  onExecute: (command: string, args?: string) => void
  /** Whether the agent is currently executing */
  isExecuting?: boolean
  /** Custom class name */
  className?: string
}

// ============================================================================
// Command Item Component
// ============================================================================

interface CommandItemProps {
  command: AcpAvailableCommand
  onExecute: (command: string, args?: string) => void
  isExecuting?: boolean
}

function CommandItem({ command, onExecute, isExecuting }: CommandItemProps) {
  const [args, setArgs] = useState("")
  const hasInput = command.input !== null && command.input !== undefined

  const handleExecute = () => {
    onExecute(`/${command.name}`, hasInput ? args : undefined)
    setArgs("")
  }

  return (
    <div className="group flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-accent">
      <Terminal className="h-4 w-4 text-muted-foreground" />
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <code className="text-sm font-medium">/{command.name}</code>
          {hasInput && (
            <Badge variant="outline" className="text-xs">
              {command.input?.hint || "args"}
            </Badge>
          )}
        </div>
        <p className="text-xs text-muted-foreground truncate">{command.description}</p>
      </div>
      <Button
        variant="ghost"
        size="sm"
        className="opacity-0 group-hover:opacity-100 transition-opacity"
        onClick={handleExecute}
        disabled={isExecuting}
      >
        <ChevronRight className="h-4 w-4" />
      </Button>
    </div>
  )
}

// ============================================================================
// Main Component
// ============================================================================

export function ExternalAgentCommands({
  commands,
  onExecute,
  isExecuting,
  className,
}: ExternalAgentCommandsProps) {
  const t = useTranslations("externalAgent")
  const [open, setOpen] = useState(false)

  if (!commands || commands.length === 0) {
    return null
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              className={cn("gap-2", className)}
              disabled={isExecuting}
            >
              <Command className="h-4 w-4" />
              <span className="hidden sm:inline">{t("commands")}</span>
              <Badge variant="secondary" className="ml-1">
                {commands.length}
              </Badge>
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent>{t("commandsTooltip")}</TooltipContent>
      </Tooltip>
      <PopoverContent className="w-80 p-0" align="start">
        <div className="p-3 border-b">
          <h4 className="font-medium text-sm">{t("availableCommands")}</h4>
          <p className="text-xs text-muted-foreground mt-1">{t("commandsDescription")}</p>
        </div>
        <ScrollArea className="h-[280px]">
          <div className="p-2 space-y-1">
            {commands.map((command) => (
              <CommandItem
                key={command.name}
                command={command}
                onExecute={(cmd, args) => {
                  onExecute(cmd, args)
                  setOpen(false)
                }}
                isExecuting={isExecuting}
              />
            ))}
          </div>
        </ScrollArea>
      </PopoverContent>
    </Popover>
  )
}
