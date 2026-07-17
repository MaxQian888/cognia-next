"use client"

import type { ComponentType, ReactNode, SVGProps } from "react"

import {
  MobileSpotIcon,
  type MobileSpotIconName,
} from "@/components/mobile/mobile-spot-icon"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty"
import { cn } from "@/lib/utils"

export interface EmptyStateProps {
  icon?: ComponentType<SVGProps<SVGSVGElement>>
  spotIcon?: MobileSpotIconName
  title: string
  description?: string
  cta?: {
    label: string
    onSelect: () => void
    testId?: string
  }
  className?: string
  children?: ReactNode
}

export function EmptyState({
  icon: Icon,
  spotIcon,
  title,
  description,
  cta,
  className,
  children,
}: EmptyStateProps) {
  return (
    <Empty
      data-testid="empty-state"
      className={cn(
        "gap-2 border border-dashed border-border bg-card/40 px-6 py-10 md:p-10",
        className
      )}
    >
      <EmptyHeader className="gap-2">
        {spotIcon ? (
          <EmptyMedia className="bg-transparent">
            <MobileSpotIcon name={spotIcon} size={96} className="-my-3" />
          </EmptyMedia>
        ) : Icon ? (
          <EmptyMedia className="bg-transparent">
            <Icon
              aria-hidden="true"
              className="size-10 text-muted-foreground/70"
              data-testid="empty-state-icon"
            />
          </EmptyMedia>
        ) : null}
        <EmptyTitle className="text-sm font-semibold tracking-normal">{title}</EmptyTitle>
        {description ? (
          <EmptyDescription className="max-w-[28ch] text-xs">{description}</EmptyDescription>
        ) : null}
      </EmptyHeader>
      {cta ? (
        <EmptyContent className="gap-2">
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={cta.onSelect}
            data-testid={cta.testId ?? "empty-state-cta"}
          >
            {cta.label}
          </Button>
        </EmptyContent>
      ) : null}
      {children}
    </Empty>
  )
}
