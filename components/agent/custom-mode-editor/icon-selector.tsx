"use client"

import { useState, useMemo } from "react"
import { useTranslations } from "next-intl"
import { Bot, ChevronDown, ChevronRight, type LucideIcon } from "lucide-react"
import { LucideIcons } from "@/lib/agent/resolve-icon"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { AVAILABLE_MODE_ICONS } from "@/stores/agent/custom-mode-store"

interface IconSelectorProps {
  value: string
  onChange: (icon: string) => void
}

export function IconSelector({ value, onChange }: IconSelectorProps) {
  const [isOpen, setIsOpen] = useState(false)
  const [search, setSearch] = useState("")
  const t = useTranslations("customMode")

  const filteredIcons = useMemo(() => {
    if (!search) return AVAILABLE_MODE_ICONS
    const lowerSearch = search.toLowerCase()
    return AVAILABLE_MODE_ICONS.filter((icon) => icon.toLowerCase().includes(lowerSearch))
  }, [search])

  const CurrentIcon = (LucideIcons[value] as LucideIcon) || Bot

  return (
    <div className="space-y-2">
      <Label>{t("icon")}</Label>
      <Collapsible open={isOpen} onOpenChange={setIsOpen}>
        <CollapsibleTrigger asChild>
          <Button variant="outline" className="w-full justify-between">
            <div className="flex items-center gap-2">
              <CurrentIcon className="h-4 w-4" />
              <span>{value}</span>
            </div>
            {isOpen ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </Button>
        </CollapsibleTrigger>
        <CollapsibleContent className="pt-2">
          <div className="space-y-2">
            <Input
              placeholder={t("searchIcons")}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
            <ScrollArea className="h-[200px] border rounded-md p-2">
              <div className="grid grid-cols-8 gap-1">
                {filteredIcons.map((iconName) => {
                  const Icon = (LucideIcons[iconName] as LucideIcon) || Bot
                  const isSelected = value === iconName
                  return (
                    <Tooltip key={iconName}>
                      <TooltipTrigger asChild>
                        <Button
                          variant={isSelected ? "default" : "ghost"}
                          size="icon"
                          className="h-8 w-8"
                          onClick={() => {
                            onChange(iconName)
                            setIsOpen(false)
                          }}
                        >
                          <Icon className="h-4 w-4" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="bottom">
                        <p>{iconName}</p>
                      </TooltipContent>
                    </Tooltip>
                  )
                })}
              </div>
            </ScrollArea>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  )
}

export type { IconSelectorProps }
