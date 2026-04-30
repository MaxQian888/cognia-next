"use client"

import { useTranslations } from "next-intl"
import { Tag } from "lucide-react"
import { Card, CardContent } from "@/components/ui/card"
import { cn } from "@/lib/utils"

interface TaskTagsDisplayProps {
  tags: string[]
  className?: string
}

export function TaskTagsDisplay({ tags, className }: TaskTagsDisplayProps) {
  const t = useTranslations("scheduler")

  return (
    <Card className={cn("border-border/50 bg-card/80", className)}>
      <CardContent className="p-4">
        <h3 className="mb-3 flex items-center gap-2 text-sm font-semibold">
          <Tag className="h-4 w-4 text-sky-500" />
          {t("tags") || "Tags"}
        </h3>
        <div className="flex flex-wrap gap-1.5">
          {tags.length === 0 ? (
            <span className="text-sm text-muted-foreground">{t("noTags") || "No tags"}</span>
          ) : (
            tags.map((tag) => (
              <span
                key={tag}
                className="rounded-full border border-border/50 bg-muted/50 px-2.5 py-0.5 text-xs text-muted-foreground"
              >
                {tag}
              </span>
            ))
          )}
        </div>
      </CardContent>
    </Card>
  )
}
