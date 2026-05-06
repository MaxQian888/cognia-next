"use client"

import React, { memo, useCallback } from "react"
import { cn } from "@/lib/utils"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { resolveIcon } from "@/lib/a2ui/resolve-icon"
import type { A2UIComponentProps, A2UIBaseComponent } from "@/types/a2ui/schema"

export interface A2UIDropdownMenuItem {
  id: string
  label: string
  action?: string
  icon?: string
  disabled?: boolean
  danger?: boolean
  separator?: boolean
}

export interface A2UIDropdownMenuComponent extends A2UIBaseComponent {
  component: "DropdownMenu"
  trigger: string
  items: A2UIDropdownMenuItem[]
  label?: string
  align?: "start" | "center" | "end"
  side?: "top" | "right" | "bottom" | "left"
}

export const A2UIDropdownMenu = memo(function A2UIDropdownMenu({
  component,
  renderChild,
  onAction,
}: A2UIComponentProps<A2UIDropdownMenuComponent>) {
  const handleAction = useCallback(
    (action?: string) => {
      if (action) onAction(action, {})
    },
    [onAction]
  )

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <span
          className={cn("inline-flex", component.className)}
          style={component.style as React.CSSProperties}
        >
          {renderChild(component.trigger)}
        </span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={component.align || "start"} side={component.side || "bottom"}>
        {component.label && <DropdownMenuLabel>{component.label}</DropdownMenuLabel>}
        {component.items.map((item) => {
          if (item.separator) {
            return <DropdownMenuSeparator key={item.id} />
          }
          const Icon = item.icon ? resolveIcon(item.icon) : null
          return (
            <DropdownMenuItem
              key={item.id}
              disabled={item.disabled}
              variant={item.danger ? "destructive" : "default"}
              onClick={() => handleAction(item.action)}
            >
              {Icon && <Icon className="mr-2 size-4" />}
              {item.label}
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
})
