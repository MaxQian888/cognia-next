"use client"

/**
 * A2UI Empty State Component
 * Displays empty state with optional action
 */

import React, { memo } from "react"
import { cn } from "@/lib/utils"
import { Inbox, Plus } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  Empty,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
  EmptyDescription,
  EmptyContent,
} from "@/components/ui/empty"
import type { A2UIComponentProps, A2UIBaseComponent } from "@/types/a2ui/schema"

export interface A2UIEmptyComponent extends A2UIBaseComponent {
  component: "Empty"
  title?: string
  message?: string
  icon?: string
  actionLabel?: string
  action?: string
}

export const A2UIEmpty = memo(function A2UIEmpty({
  component,
  onAction,
}: A2UIComponentProps<A2UIEmptyComponent>) {
  const handleAction = () => {
    if (component.action) {
      onAction(component.action, {})
    }
  }

  return (
    <Empty
      className={cn("min-h-[200px]", component.className)}
      style={component.style as React.CSSProperties}
    >
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Inbox className="h-8 w-8 text-muted-foreground" />
        </EmptyMedia>
        {component.title && <EmptyTitle>{component.title}</EmptyTitle>}
        {component.message && <EmptyDescription>{component.message}</EmptyDescription>}
      </EmptyHeader>

      {component.action && component.actionLabel && (
        <EmptyContent>
          <Button onClick={handleAction}>
            <Plus className="mr-2 h-4 w-4" />
            {component.actionLabel}
          </Button>
        </EmptyContent>
      )}
    </Empty>
  )
})
