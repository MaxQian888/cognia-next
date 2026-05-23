"use client"

import { useTranslations } from "next-intl"
import { Bot, type LucideIcon } from "lucide-react"
import { LucideIcons } from "@/lib/agent/resolve-icon"
import { Badge } from "@/components/ui/badge"
import { Label } from "@/components/ui/label"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Card, CardContent } from "@/components/ui/card"
import { MODE_TEMPLATES, type ModeTemplate } from "@/stores/agent/custom-mode-store"

interface TemplateSelectorProps {
  onSelect: (template: ModeTemplate) => void
}

export function TemplateSelector({ onSelect }: TemplateSelectorProps) {
  const t = useTranslations("customMode")

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <Label>{t("templates") || "Quick Start Templates"}</Label>
        <Badge variant="outline">
          {MODE_TEMPLATES.length} {t("available") || "available"}
        </Badge>
      </div>
      <ScrollArea className="h-[180px]">
        <div className="grid grid-cols-2 gap-2 pr-4">
          {MODE_TEMPLATES.map((template) => {
            const Icon = (LucideIcons[template.icon] as LucideIcon) || Bot
            return (
              <Card
                key={template.id}
                className="cursor-pointer hover:bg-accent transition-colors"
                onClick={() => onSelect(template)}
              >
                <CardContent className="p-3">
                  <div className="flex items-start gap-2">
                    <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-muted">
                      <Icon className="h-4 w-4" />
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="font-medium text-sm truncate">{template.name}</p>
                      <p className="text-xs text-muted-foreground line-clamp-2">
                        {template.description}
                      </p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )
          })}
        </div>
      </ScrollArea>
    </div>
  )
}

export type { TemplateSelectorProps }
