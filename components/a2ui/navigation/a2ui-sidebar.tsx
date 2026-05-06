"use client"

import React, { memo } from "react"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
} from "@/components/ui/sidebar"
import type { A2UIComponentProps, A2UIBaseComponent } from "@/types/a2ui/schema"

export interface A2UISidebarNavItem {
  id: string
  label: string
  icon?: string
  action?: string
  active?: boolean
}

export interface A2UISidebarGroup {
  id: string
  label?: string
  items: A2UISidebarNavItem[]
}

export interface A2UISidebarComponent extends A2UIBaseComponent {
  component: "Sidebar"
  groups: A2UISidebarGroup[]
  header?: string
  footer?: string
  collapsed?: boolean
  side?: "left" | "right"
}

export const A2UISidebar = memo(function A2UISidebar({
  component,
  onAction,
}: A2UIComponentProps<A2UISidebarComponent>) {
  return (
    <SidebarProvider defaultOpen={!component.collapsed}>
      <Sidebar
        side={component.side || "left"}
        className={component.className}
        style={component.style as React.CSSProperties}
      >
        {component.header && (
          <SidebarHeader>
            <div className="px-3 py-2 text-sm font-semibold">{component.header}</div>
          </SidebarHeader>
        )}
        <SidebarContent>
          {component.groups.map((group) => (
            <SidebarGroup key={group.id}>
              {group.label && <SidebarGroupLabel>{group.label}</SidebarGroupLabel>}
              <SidebarGroupContent>
                <SidebarMenu>
                  {group.items.map((item) => (
                    <SidebarMenuItem key={item.id}>
                      <SidebarMenuButton
                        isActive={item.active}
                        onClick={() => item.action && onAction(item.action, { itemId: item.id })}
                      >
                        {item.label}
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  ))}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          ))}
        </SidebarContent>
        {component.footer && (
          <SidebarFooter>
            <div className="px-3 py-2 text-xs text-muted-foreground">{component.footer}</div>
          </SidebarFooter>
        )}
      </Sidebar>
    </SidebarProvider>
  )
})
