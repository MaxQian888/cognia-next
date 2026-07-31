"use client"

import React, { memo } from "react"
import { useTranslations } from "next-intl"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Card, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Plus, Sparkles } from "lucide-react"
import { resolveIcon } from "@/lib/a2ui/resolve-icon"
import type { A2UIAppTemplate } from "@/lib/a2ui/templates"

interface TemplateCardProps {
  template: A2UIAppTemplate
  viewMode: "grid" | "list"
  onSelect: (template: A2UIAppTemplate) => void
}

export const TemplateCard = memo(function TemplateCard({
  template,
  viewMode,
  onSelect,
}: TemplateCardProps) {
  const t = useTranslations("a2ui")
  const IconComponent = resolveIcon(template.icon)

  return (
    <Card
      className={cn(
        "group cursor-pointer transition-all hover:shadow-md hover:border-primary/50",
        viewMode === "list" && "flex flex-row items-center"
      )}
      onClick={() => onSelect(template)}
    >
      <CardHeader className={cn(viewMode === "list" && "flex-1 py-3")}>
        <div className="flex items-start gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-primary/10">
            {IconComponent ? (
              React.createElement(IconComponent, { className: "h-5 w-5 text-primary" })
            ) : (
              <Sparkles className="h-5 w-5 text-primary" />
            )}
          </div>
          <div className="flex-1 min-w-0">
            <CardTitle className="text-sm">{template.name}</CardTitle>
            <CardDescription className="text-xs line-clamp-2">
              {template.description}
            </CardDescription>
          </div>
        </div>
      </CardHeader>
      {viewMode === "grid" && (
        <CardFooter className="pt-0">
          <div className="flex flex-wrap gap-1">
            {template.tags.slice(0, 3).map((tag) => (
              <Badge key={tag} variant="secondary" className="text-xs">
                {tag}
              </Badge>
            ))}
          </div>
        </CardFooter>
      )}
      {viewMode === "list" && (
        <div className="flex items-center gap-2 pr-4">
          <Button
            size="sm"
            variant="ghost"
            className="opacity-0 group-hover:opacity-100"
            onClick={(e) => {
              e.stopPropagation()
              onSelect(template)
            }}
          >
            <Plus className="h-4 w-4 mr-1" />
            {t("create")}
          </Button>
        </div>
      )}
    </Card>
  )
})
