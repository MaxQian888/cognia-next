"use client"

import { Children, type ReactNode, useId } from "react"

import { Badge } from "@/components/ui/badge"
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item"
import { Separator } from "@/components/ui/separator"
import { cn } from "@/lib/utils"

interface GatewayPanelStackProps {
  children: ReactNode
  className?: string
}

/** Flat panel sections separated by the shared shadcn divider. */
export function GatewayPanelStack({ children, className }: GatewayPanelStackProps) {
  const sections = Children.toArray(children)

  return (
    <div className={cn("flex flex-col", className)}>
      {sections.map((section, index) => (
        <div key={index}>
          {index > 0 ? <Separator className="my-5" /> : null}
          {section}
        </div>
      ))}
    </div>
  )
}

interface GatewayPanelSectionProps {
  title: string
  description?: string
  icon?: ReactNode
  badge?: string
  badgeVariant?: "default" | "secondary" | "outline" | "destructive"
  action?: ReactNode
  children: ReactNode
  className?: string
}

/**
 * A borderless gateway detail section.
 *
 * The master/detail pane already provides the containing surface. This keeps
 * headings, descriptions, badges, actions, and spacing consistent without
 * nesting another card around every group of fields.
 */
export function GatewayPanelSection({
  title,
  description,
  icon,
  badge,
  badgeVariant = "secondary",
  action,
  children,
  className,
}: GatewayPanelSectionProps) {
  const titleId = useId()

  return (
    <section aria-labelledby={titleId} className={cn("flex flex-col gap-4", className)}>
      <Item size="sm" className="p-0">
        {icon ? <ItemMedia className="text-muted-foreground">{icon}</ItemMedia> : null}
        <ItemContent>
          <ItemTitle className="w-full flex-wrap">
            <h3 id={titleId}>{title}</h3>
            {badge ? (
              <Badge variant={badgeVariant} className="text-[10px]">
                {badge}
              </Badge>
            ) : null}
          </ItemTitle>
          {description ? (
            <ItemDescription className="line-clamp-none text-xs">{description}</ItemDescription>
          ) : null}
        </ItemContent>
        {action ? <ItemActions className="max-w-full flex-wrap">{action}</ItemActions> : null}
      </Item>
      <div className="flex flex-col gap-4">{children}</div>
    </section>
  )
}
