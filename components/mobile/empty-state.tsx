"use client"

import type { ComponentType, ReactNode, SVGProps } from "react"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export interface EmptyStateProps {
  icon?: ComponentType<SVGProps<SVGSVGElement>>
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
  title,
  description,
  cta,
  className,
  children,
}: EmptyStateProps) {
  return (
    <div
      data-testid="empty-state"
      className={cn(
        "flex flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border bg-card/40 px-6 py-10 text-center",
        className
      )}
    >
      {Icon ? (
        <Icon
          aria-hidden="true"
          className="size-10 text-muted-foreground/70"
          data-testid="empty-state-icon"
        />
      ) : null}
      <h3 className="text-sm font-semibold">{title}</h3>
      {description ? (
        <p className="max-w-[28ch] text-xs text-muted-foreground">{description}</p>
      ) : null}
      {cta ? (
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={cta.onSelect}
          data-testid={cta.testId ?? "empty-state-cta"}
        >
          {cta.label}
        </Button>
      ) : null}
      {children}
    </div>
  )
}
