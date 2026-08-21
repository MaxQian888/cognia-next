"use client"

import React, { memo } from "react"
import { useTranslations } from "next-intl"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Card, CardDescription, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { Plus, Sparkles } from "lucide-react"
import { resolveIcon } from "@/lib/a2ui/resolve-icon"
import type { A2UIAppTemplate } from "@/lib/a2ui/templates"

interface TemplateCardProps {
  template: A2UIAppTemplate
  viewMode: "grid" | "list"
  onSelect: (template: A2UIAppTemplate) => void
}

/**
 * Template tile for the Mini-Apps hub.
 *
 * Density matches the app cards it sits under: one `rounded-xl` card (the
 * `--radius-xl` token), a `rounded-lg` icon tile, and nothing else rounded.
 * The default `Card` padding is dropped so the tile does not tower over the
 * app grid beside it.
 */
export const TemplateCard = memo(function TemplateCard({
  template,
  viewMode,
  onSelect,
}: TemplateCardProps) {
  const t = useTranslations("a2ui")
  const IconComponent = resolveIcon(template.icon)

  const icon = (
    <div className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
      {IconComponent ? (
        React.createElement(IconComponent, { className: "size-4" })
      ) : (
        <Sparkles className="size-4" />
      )}
    </div>
  )

  return (
    <Card
      data-testid="a2ui-template-card"
      className={cn(
        "group cursor-pointer gap-0 py-0",
        "transition-[border-color,box-shadow] duration-200 motion-reduce:transition-none",
        "hover:border-primary/40 hover:shadow-sm",
        viewMode === "list" ? "flex-row items-center gap-3 px-3 py-2.5" : "p-3"
      )}
      onClick={() => onSelect(template)}
    >
      {viewMode === "list" ? (
        <>
          {icon}
          <div className="min-w-0 flex-1">
            <CardTitle className="truncate text-sm">{template.name}</CardTitle>
            <CardDescription className="truncate text-xs">{template.description}</CardDescription>
          </div>
          <Button
            size="sm"
            variant="ghost"
            className="shrink-0 text-muted-foreground hover:text-foreground"
            onClick={(e) => {
              e.stopPropagation()
              onSelect(template)
            }}
          >
            <Plus className="size-4" />
            {t("create")}
          </Button>
        </>
      ) : (
        <div className="flex items-start gap-2.5">
          {icon}
          <div className="flex min-w-0 flex-1 flex-col gap-1">
            <CardTitle className="truncate text-sm">{template.name}</CardTitle>
            <CardDescription className="line-clamp-2 text-xs">
              {template.description}
            </CardDescription>
            {template.tags.length > 0 && (
              <div className="mt-0.5 flex flex-wrap gap-1">
                {template.tags.slice(0, 3).map((tag) => (
                  <Badge key={tag} variant="outline" className="h-4 px-1.5 text-[10px] font-normal">
                    {tag}
                  </Badge>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </Card>
  )
})
