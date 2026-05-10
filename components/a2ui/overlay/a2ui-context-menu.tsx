"use client"

import React, { memo, useCallback } from "react"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import { resolveIcon } from "@/lib/a2ui/resolve-icon"
import { getPluginEventHooks } from "@/lib/plugin"
import type { A2UIComponentProps, A2UIBaseComponent } from "@/types/a2ui/schema"
import type { A2UIDropdownMenuItem } from "./a2ui-dropdown-menu"

export interface A2UIContextMenuComponent extends A2UIBaseComponent {
  component: "ContextMenu"
  trigger: string
  items: A2UIDropdownMenuItem[]
  label?: string
}

export const A2UIContextMenu = memo(function A2UIContextMenu({
  component,
  renderChild,
  onAction,
}: A2UIComponentProps<A2UIContextMenuComponent>) {
  const handleAction = useCallback(
    (action?: string) => {
      if (action) onAction(action, {})
    },
    [onAction]
  )

  return (
    <ContextMenu
      onOpenChange={(open) => {
        if (open) {
          // Plugin host: announce the context-menu open so plugins can react
          // (e.g. inject extra items via host registries — Phase 1 dispatch only).
          void getPluginEventHooks().dispatchContextMenuShow({
            type: "a2ui",
            target: { trigger: component.trigger, label: component.label },
          })
        }
      }}
    >
      <ContextMenuTrigger asChild>
        <div className={component.className} style={component.style as React.CSSProperties}>
          {renderChild(component.trigger)}
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        {component.label && <ContextMenuLabel>{component.label}</ContextMenuLabel>}
        {component.items.map((item) => {
          if (item.separator) {
            return <ContextMenuSeparator key={item.id} />
          }
          const Icon = item.icon ? resolveIcon(item.icon) : null
          return (
            <ContextMenuItem
              key={item.id}
              disabled={item.disabled}
              variant={item.danger ? "destructive" : "default"}
              onClick={() => handleAction(item.action)}
            >
              {Icon && <Icon className="mr-2 size-4" />}
              {item.label}
            </ContextMenuItem>
          )
        })}
      </ContextMenuContent>
    </ContextMenu>
  )
})
