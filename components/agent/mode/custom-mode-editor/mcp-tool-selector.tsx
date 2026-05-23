"use client"

import { useState, useMemo, useCallback } from "react"
import { useTranslations } from "next-intl"
import { ChevronDown, ChevronRight, Check, X, Settings, Sparkles } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { DEFAULT_TOOL_SELECTION_CONFIG } from "@/types/mcp"
import {
  getRecommendedMcpToolsForMode,
  type CustomModeCategory,
  type McpToolReference,
} from "@/stores/agent/custom-mode-store"
import { useMcpStore } from "@/stores/mcp/mcp-store"

interface McpToolSelectorRecommendationContext {
  name: string
  description: string
  systemPrompt: string
  category?: CustomModeCategory
}

interface McpToolSelectorProps {
  value: McpToolReference[]
  onChange: (tools: McpToolReference[]) => void
  recommendationContext?: McpToolSelectorRecommendationContext
}

function getToolKey(serverId: string, toolName: string): string {
  return `${serverId}:${toolName}`
}

export function McpToolSelector({ value, onChange, recommendationContext }: McpToolSelectorProps) {
  const [expandedServers, setExpandedServers] = useState<Set<string>>(new Set())
  const t = useTranslations("customMode")
  const mcpServers = useMcpStore((state) => state.servers)
  const toolSelectionConfig =
    useMcpStore((state) => state.toolSelectionConfig) ?? DEFAULT_TOOL_SELECTION_CONFIG
  const lastToolSelection = useMcpStore((state) => state.lastToolSelection) ?? null

  const connectedServers = useMemo(
    () => mcpServers.filter((s) => s.status.type === "connected"),
    [mcpServers]
  )

  const availableTools = useMemo(
    () =>
      connectedServers.flatMap((server) =>
        (server.tools || []).map((tool) => ({
          serverId: server.id,
          toolName: tool.name,
          displayName: tool.description || tool.name,
        }))
      ),
    [connectedServers]
  )

  const recommendationsEnabled = useMemo(() => {
    if (!recommendationContext) {
      return false
    }

    return Boolean(
      recommendationContext.name.trim() ||
      recommendationContext.description.trim() ||
      recommendationContext.systemPrompt.trim()
    )
  }, [recommendationContext])

  const recommendedTools = useMemo(() => {
    if (!recommendationsEnabled || !recommendationContext) {
      return []
    }

    const recommendations = getRecommendedMcpToolsForMode(
      availableTools,
      recommendationContext,
      toolSelectionConfig.maxTools
    )

    return Array.isArray(recommendations) ? recommendations : []
  }, [availableTools, recommendationContext, recommendationsEnabled, toolSelectionConfig.maxTools])

  const recommendedToolKeys = useMemo(
    () => new Set(recommendedTools.map((tool) => getToolKey(tool.serverId, tool.toolName))),
    [recommendedTools]
  )

  const applyRecommendedTools = useCallback(() => {
    onChange(recommendedTools.map(({ relevanceScore: _, ...tool }) => tool))
  }, [onChange, recommendedTools])

  const toggleServer = (serverId: string) => {
    const newExpanded = new Set(expandedServers)
    if (newExpanded.has(serverId)) {
      newExpanded.delete(serverId)
    } else {
      newExpanded.add(serverId)
    }
    setExpandedServers(newExpanded)
  }

  const isToolSelected = (serverId: string, toolName: string) => {
    return value.some((t) => t.serverId === serverId && t.toolName === toolName)
  }

  const toggleTool = (serverId: string, toolName: string, displayName?: string) => {
    if (isToolSelected(serverId, toolName)) {
      onChange(value.filter((t) => !(t.serverId === serverId && t.toolName === toolName)))
    } else {
      onChange([...value, { serverId, toolName, displayName }])
    }
  }

  const toggleAllInServer = (serverId: string, tools: Array<{ name: string }>) => {
    const serverToolNames = tools.map((t) => t.name)
    const allSelected = serverToolNames.every((name) => isToolSelected(serverId, name))

    if (allSelected) {
      onChange(value.filter((t) => t.serverId !== serverId))
    } else {
      const newTools = [...value.filter((t) => t.serverId !== serverId)]
      for (const tool of tools) {
        newTools.push({ serverId, toolName: tool.name, displayName: tool.name })
      }
      onChange(newTools)
    }
  }

  if (connectedServers.length === 0) {
    return (
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label>{t("mcpTools") || "MCP Tools"}</Label>
        </div>
        <div className="flex items-center justify-center h-[100px] border rounded-md text-muted-foreground text-sm">
          {t("noMcpServers") || "No MCP servers connected"}
        </div>
      </div>
    )
  }

  const selectedCount = value.length
  const overBudget = selectedCount > toolSelectionConfig.maxTools

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label>{t("mcpTools") || "MCP Tools"}</Label>
        <Badge variant={overBudget ? "destructive" : "secondary"}>
          {selectedCount} {t("selected")}
        </Badge>
      </div>
      <div className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground space-y-2">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="font-medium text-foreground">{t("mcpBudgetTitle")}</p>
            <p>
              {t("mcpBudgetDescription", {
                maxTools: String(toolSelectionConfig.maxTools),
                minTools: String(toolSelectionConfig.minSelectedTools),
              })}
            </p>
          </div>
          {overBudget && <Badge variant="destructive">{t("mcpOverBudget")}</Badge>}
        </div>
        {lastToolSelection && (
          <div className="flex flex-wrap items-center gap-2 text-[11px]">
            <span>
              {t("mcpLastSelectionSummary", {
                selected: String(lastToolSelection.selectedToolNames.length),
                total: String(lastToolSelection.totalAvailable),
              })}
            </span>
            {lastToolSelection.wasLimited && (
              <Badge variant="outline">{t("mcpSelectionLimited")}</Badge>
            )}
            {lastToolSelection.fallbackApplied && (
              <Badge variant="outline">{t("mcpSelectionFallback")}</Badge>
            )}
          </div>
        )}
      </div>
      <div className="rounded-md border border-dashed p-3 space-y-2">
        <div className="flex items-center justify-between gap-3">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Sparkles className="h-3.5 w-3.5 text-primary" />
              <span className="text-sm font-medium">{t("mcpRecommendationsTitle")}</span>
            </div>
            <p className="text-xs text-muted-foreground">
              {recommendationsEnabled
                ? t("mcpRecommendationsDescription", {
                    count: String(recommendedTools.length),
                    maxTools: String(toolSelectionConfig.maxTools),
                  })
                : t("mcpRecommendationsHint")}
            </p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={applyRecommendedTools}
            disabled={!recommendationsEnabled || recommendedTools.length === 0}
          >
            {t("applyRecommendedMcpTools")}
          </Button>
        </div>
        {recommendationsEnabled && recommendedTools.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {recommendedTools.slice(0, 6).map((tool) => (
              <Badge key={getToolKey(tool.serverId, tool.toolName)} variant="outline">
                {tool.toolName} {Math.round(tool.relevanceScore * 100)}%
              </Badge>
            ))}
          </div>
        )}
      </div>
      <ScrollArea className="h-[200px] border rounded-md">
        <div className="p-2 space-y-1">
          {connectedServers.map((server) => {
            const isExpanded = expandedServers.has(server.id)
            const serverTools = server.tools || []
            const selectedInServer = serverTools.filter((t) =>
              isToolSelected(server.id, t.name)
            ).length

            return (
              <Collapsible
                key={server.id}
                open={isExpanded}
                onOpenChange={() => toggleServer(server.id)}
              >
                <div className="flex items-center gap-2">
                  <CollapsibleTrigger asChild>
                    <Button variant="ghost" size="sm" className="flex-1 justify-start gap-2">
                      {isExpanded ? (
                        <ChevronDown className="h-4 w-4" />
                      ) : (
                        <ChevronRight className="h-4 w-4" />
                      )}
                      <Settings className="h-4 w-4" />
                      <span className="flex-1 text-left truncate">{server.name}</span>
                      <Badge variant="outline" className="ml-2">
                        {selectedInServer}/{serverTools.length}
                      </Badge>
                    </Button>
                  </CollapsibleTrigger>
                  {serverTools.length > 0 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => toggleAllInServer(server.id, serverTools)}
                    >
                      {selectedInServer === serverTools.length ? (
                        <X className="h-4 w-4" />
                      ) : (
                        <Check className="h-4 w-4" />
                      )}
                    </Button>
                  )}
                </div>
                <CollapsibleContent>
                  <div className="ml-6 mt-1 space-y-1">
                    {serverTools.map((tool) => {
                      const isSelected = isToolSelected(server.id, tool.name)
                      const isRecommended = recommendedToolKeys.has(
                        getToolKey(server.id, tool.name)
                      )
                      return (
                        <Tooltip key={tool.name}>
                          <TooltipTrigger asChild>
                            <Button
                              variant={isSelected ? "secondary" : "ghost"}
                              size="sm"
                              className={cn(
                                "w-full justify-start text-xs",
                                isRecommended && !isSelected && "border border-primary/30"
                              )}
                              onClick={() => toggleTool(server.id, tool.name, tool.name)}
                            >
                              {isSelected && <Check className="h-3 w-3 mr-2" />}
                              <span className="truncate">{tool.name}</span>
                              {isRecommended && (
                                <Badge variant="outline" className="ml-auto text-[10px]">
                                  {t("recommended")}
                                </Badge>
                              )}
                            </Button>
                          </TooltipTrigger>
                          <TooltipContent side="right" className="max-w-[300px]">
                            <p className="text-xs">{tool.description || "No description"}</p>
                          </TooltipContent>
                        </Tooltip>
                      )
                    })}
                  </div>
                </CollapsibleContent>
              </Collapsible>
            )
          })}
        </div>
      </ScrollArea>
    </div>
  )
}

export type { McpToolSelectorProps }
