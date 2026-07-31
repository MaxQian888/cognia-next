"use client"

/**
 * External Agent Config Options Component
 *
 * Renders session config option selectors per ACP spec.
 * Supports mode, model, thought_level, and custom categories.
 * @see https://agentclientprotocol.com/protocol/session-config-options
 */

import { useCallback } from "react"
import { toast } from "sonner"
import { useTranslations } from "next-intl"
import { Settings2, Brain, Cpu, Sparkles } from "lucide-react"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { Switch } from "@/components/ui/switch"
import { cn } from "@/lib/utils"
import type { AcpConfigOption, AcpConfigOptionCategory } from "@/types/agent/external-agent"

// ============================================================================
// Types
// ============================================================================

interface ExternalAgentConfigOptionsProps {
  configOptions: AcpConfigOption[]
  onSetConfigOption: (configId: string, value: string | boolean) => Promise<AcpConfigOption[]>
  disabled?: boolean
  className?: string
  compact?: boolean
}

// ============================================================================
// Category Icon Helper
// ============================================================================

function getCategoryIcon(category?: AcpConfigOptionCategory) {
  switch (category) {
    case "mode":
      return <Settings2 className="h-3.5 w-3.5" />
    case "model":
      return <Cpu className="h-3.5 w-3.5" />
    case "thought_level":
      return <Brain className="h-3.5 w-3.5" />
    default:
      return <Sparkles className="h-3.5 w-3.5" />
  }
}

// ============================================================================
// Single Config Option Selector
// ============================================================================

function ConfigOptionSelector({
  option,
  onSelect,
  disabled,
  compact,
}: {
  option: AcpConfigOption
  onSelect: (value: string | boolean) => void
  disabled?: boolean
  compact?: boolean
}) {
  const handleSelectChange = (value: string) => {
    if (option.type === "select" && value !== option.currentValue) {
      onSelect(value)
    }
  }

  if (option.type === "boolean") {
    const toggle = (
      <Switch
        checked={option.currentValue}
        onCheckedChange={onSelect}
        disabled={disabled}
        aria-label={option.name}
      />
    )
    if (compact) {
      return (
        <Tooltip>
          <TooltipTrigger asChild>
            <div className="inline-flex items-center gap-1 rounded-md bg-muted/50 px-2 py-1">
              {getCategoryIcon(option.category)}
              {toggle}
            </div>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            <p className="font-medium">{option.name}</p>
            {option.description && (
              <p className="text-xs text-muted-foreground">{option.description}</p>
            )}
          </TooltipContent>
        </Tooltip>
      )
    }
    return (
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
          {getCategoryIcon(option.category)}
          <span className="min-w-[60px]">{option.name}</span>
        </div>
        {toggle}
      </div>
    )
  }

  const values = option.options.flatMap((entry) => ("group" in entry ? entry.options : [entry]))

  const icon = getCategoryIcon(option.category)

  if (compact) {
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="inline-flex items-center">
            <Select
              value={option.currentValue}
              onValueChange={handleSelectChange}
              disabled={disabled}
            >
              <SelectTrigger className="h-7 w-auto min-w-[80px] gap-1 border-none bg-muted/50 px-2 text-xs">
                {icon}
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {values.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    <div className="flex flex-col">
                      <span>{opt.name}</span>
                      {opt.description && (
                        <span className="text-xs text-muted-foreground">{opt.description}</span>
                      )}
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          <p className="font-medium">{option.name}</p>
          {option.description && (
            <p className="text-xs text-muted-foreground">{option.description}</p>
          )}
        </TooltipContent>
      </Tooltip>
    )
  }

  return (
    <div className="flex items-center gap-2">
      <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
        {icon}
        <span className="min-w-[60px]">{option.name}</span>
      </div>
      <Select value={option.currentValue} onValueChange={handleSelectChange} disabled={disabled}>
        <SelectTrigger className="h-8 flex-1">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {values.map((opt) => (
            <SelectItem key={opt.value} value={opt.value}>
              <div className="flex flex-col">
                <span>{opt.name}</span>
                {opt.description && (
                  <span className="text-xs text-muted-foreground">{opt.description}</span>
                )}
              </div>
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

// ============================================================================
// Main Component
// ============================================================================

export function ExternalAgentConfigOptions({
  configOptions,
  onSetConfigOption,
  disabled = false,
  className,
  compact = false,
}: ExternalAgentConfigOptionsProps) {
  const t = useTranslations("externalAgent")
  const handleSelect = useCallback(
    async (configId: string, value: string | boolean) => {
      try {
        await onSetConfigOption(configId, value)
      } catch (_error) {
        toast.error(t("setConfigOptionFailed"))
      }
    },
    [onSetConfigOption, t]
  )

  if (!configOptions.length) {
    return null
  }

  if (compact) {
    return (
      <div className={cn("flex items-center gap-1", className)}>
        {configOptions.map((option) => (
          <ConfigOptionSelector
            key={option.id}
            option={option}
            onSelect={(value) => handleSelect(option.id, value)}
            disabled={disabled}
            compact
          />
        ))}
      </div>
    )
  }

  return (
    <div className={cn("space-y-2", className)}>
      {configOptions.map((option) => (
        <ConfigOptionSelector
          key={option.id}
          option={option}
          onSelect={(value) => handleSelect(option.id, value)}
          disabled={disabled}
        />
      ))}
    </div>
  )
}
