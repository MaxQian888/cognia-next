"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { ChevronDown, ChevronRight, Check, X, Settings, type LucideIcon } from "lucide-react"
import { LucideIcons } from "@/lib/agent/resolve-icon"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { TOOL_CATEGORIES } from "@/stores/agent/custom-mode-store"

interface ToolSelectorProps {
  value: string[]
  onChange: (tools: string[]) => void
}

export function ToolSelector({ value, onChange }: ToolSelectorProps) {
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set())
  const t = useTranslations("customMode")

  const toggleCategory = (category: string) => {
    const newExpanded = new Set(expandedCategories)
    if (newExpanded.has(category)) {
      newExpanded.delete(category)
    } else {
      newExpanded.add(category)
    }
    setExpandedCategories(newExpanded)
  }

  const toggleTool = (tool: string) => {
    if (value.includes(tool)) {
      onChange(value.filter((t) => t !== tool))
    } else {
      onChange([...value, tool])
    }
  }

  const toggleAllInCategory = (tools: readonly string[]) => {
    const allSelected = tools.every((t) => value.includes(t))
    if (allSelected) {
      onChange(value.filter((t) => !tools.includes(t)))
    } else {
      const newTools = new Set([...value, ...tools])
      onChange(Array.from(newTools))
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <Label>{t("tools")}</Label>
        <Badge variant="secondary">
          {value.length} {t("selected")}
        </Badge>
      </div>
      <ScrollArea className="h-[300px] border rounded-md">
        <div className="p-2 space-y-1">
          {Object.entries(TOOL_CATEGORIES).map(([key, category]) => {
            const isExpanded = expandedCategories.has(key)
            const selectedCount = category.tools.filter((t) => value.includes(t)).length
            const Icon = (LucideIcons[category.icon] as LucideIcon) || Settings

            return (
              <Collapsible key={key} open={isExpanded} onOpenChange={() => toggleCategory(key)}>
                <div className="flex items-center gap-2">
                  <CollapsibleTrigger asChild>
                    <Button variant="ghost" size="sm" className="flex-1 justify-start gap-2">
                      {isExpanded ? (
                        <ChevronDown className="h-4 w-4" />
                      ) : (
                        <ChevronRight className="h-4 w-4" />
                      )}
                      <Icon className="h-4 w-4" />
                      <span className="flex-1 text-left">{category.name}</span>
                      <Badge variant="outline" className="ml-2">
                        {selectedCount}/{category.tools.length}
                      </Badge>
                    </Button>
                  </CollapsibleTrigger>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => toggleAllInCategory(category.tools)}
                  >
                    {selectedCount === category.tools.length ? (
                      <X className="h-4 w-4" />
                    ) : (
                      <Check className="h-4 w-4" />
                    )}
                  </Button>
                </div>
                <CollapsibleContent>
                  <div className="ml-6 mt-1 space-y-1">
                    {category.tools.map((tool) => {
                      const isSelected = value.includes(tool)
                      return (
                        <Button
                          key={tool}
                          variant={isSelected ? "secondary" : "ghost"}
                          size="sm"
                          className="w-full justify-start text-xs"
                          onClick={() => toggleTool(tool)}
                        >
                          {isSelected && <Check className="h-3 w-3 mr-2" />}
                          {tool}
                        </Button>
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

export type { ToolSelectorProps }
