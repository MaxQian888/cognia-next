"use client"

import { useTranslations } from "next-intl"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Badge } from "@/components/ui/badge"
import { resolveArrayOrPath, resolveStringOrPath } from "@/lib/a2ui/data-model"
import type {
  A2UIComparisonCardItem,
  A2UIComparisonCardsComponent,
  A2UIComponentProps,
} from "@/types/a2ui/schema"

export function A2UIComparisonCards({
  component,
  dataModel,
  onAction,
}: A2UIComponentProps<A2UIComparisonCardsComponent>) {
  const t = useTranslations("a2ui")
  const title = resolveStringOrPath(component.title ?? "", dataModel, "")
  const description = resolveStringOrPath(component.description ?? "", dataModel, "")
  const items = resolveArrayOrPath(component.items, dataModel, []) as A2UIComparisonCardItem[]

  if (items.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border/70 bg-muted/20 px-4 py-3 text-sm text-muted-foreground">
        {component.emptyText || t("comparisonEmpty")}
      </div>
    )
  }

  return (
    <div className="space-y-3">
      {title || description ? (
        <div className="space-y-1">
          {title ? <h4 className="text-sm font-semibold">{title}</h4> : null}
          {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
        </div>
      ) : null}
      <div className="grid gap-3 @md:grid-cols-2">
        {items.map((item) => {
          const card = (
            <Card className="h-full border-border/60 bg-background/80 text-left">
              <CardHeader className="pb-2">
                <div className="flex items-start justify-between gap-2">
                  <div className="space-y-1">
                    <CardTitle className="text-sm">{item.title}</CardTitle>
                    {item.description ? (
                      <CardDescription className="text-xs">{item.description}</CardDescription>
                    ) : null}
                  </div>
                  {item.badge ? <Badge variant="outline">{item.badge}</Badge> : null}
                </div>
              </CardHeader>
              {item.value || item.footer ? (
                <CardContent className="space-y-2 pt-0">
                  {item.value ? (
                    <div className="text-2xl font-semibold tracking-tight">{item.value}</div>
                  ) : null}
                  {item.footer ? (
                    <p className="text-xs text-muted-foreground">{item.footer}</p>
                  ) : null}
                </CardContent>
              ) : null}
            </Card>
          )

          if (!component.itemClickAction) {
            return <div key={item.id}>{card}</div>
          }

          return (
            <button
              key={item.id}
              type="button"
              className="cursor-pointer rounded-xl text-left transition-all duration-150 hover:-translate-y-0.5 hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring motion-reduce:transition-none motion-reduce:hover:translate-y-0"
              onClick={() =>
                onAction(component.itemClickAction!, {
                  itemId: item.id,
                  value: item.value,
                })
              }
            >
              {card}
            </button>
          )
        })}
      </div>
    </div>
  )
}
