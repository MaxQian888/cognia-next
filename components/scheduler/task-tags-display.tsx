"use client"

import { useTranslations } from "next-intl"
import { Tag } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

interface TaskTagsDisplayProps {
  tags: string[]
  className?: string
  /**
   * `card` (default) draws its own titled card; `bare` renders only the
   * badges, for a host that already supplies the section title.
   */
  variant?: "card" | "bare"
}

export function TaskTagsDisplay({ tags, className, variant = "card" }: TaskTagsDisplayProps) {
  const t = useTranslations("scheduler")

  const badges = (
    <div className="flex flex-wrap gap-1.5" data-testid="task-tags-badges">
      {tags.length === 0 ? (
        <span className="text-sm text-muted-foreground">{t("noTags")}</span>
      ) : (
        tags.map((tag) => (
          <Badge key={tag} variant="outline" className="rounded-full text-xs text-muted-foreground">
            {tag}
          </Badge>
        ))
      )}
    </div>
  )

  if (variant === "bare") return <div className={className}>{badges}</div>

  return (
    <Card className={cn("border-border/50 bg-card/80", className)}>
      <CardContent className="p-4">
        <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold">
          <Tag className="h-4 w-4 text-sky-500" />
          {t("tags")}
        </h3>
        {badges}
      </CardContent>
    </Card>
  )
}
