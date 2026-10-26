"use client"

/**
 * A2UI Tabs Component
 * Maps to shadcn/ui Tabs for tabbed content
 */

import React, { useState, memo } from "react"
import { resolveIcon } from "@/lib/a2ui/resolve-icon"
import { cn } from "@/lib/utils"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import type { A2UIComponentProps, A2UITabsComponent } from "@/types/a2ui/schema"
import { useA2UIData } from "../a2ui-context"
import { resolveStringOrPath, getBindingPath } from "@/lib/a2ui/data-model"
import { A2UIChildRenderer } from "../a2ui-child-renderer"

export const A2UITabs = memo(function A2UITabs({
  component,
  onAction,
  onDataChange,
}: A2UIComponentProps<A2UITabsComponent>) {
  const { dataModel } = useA2UIData()

  const activeTabFromData = component.activeTab
    ? resolveStringOrPath(component.activeTab, dataModel, "")
    : ""

  const defaultTab = component.defaultTab || component.tabs[0]?.id || ""
  const [internalTab, setActiveTab] = useState(defaultTab)
  const activeTab =
    component.activeTab !== undefined ? activeTabFromData || defaultTab : internalTab
  const bindingPath = getBindingPath(component.activeTab)

  const handleTabChange = (value: string) => {
    if (bindingPath) onDataChange(bindingPath, value)
    else setActiveTab(value)
    if (component.tabChangeAction) {
      onAction(component.tabChangeAction, { tab: value })
    }
  }

  return (
    <Tabs
      value={activeTab}
      onValueChange={handleTabChange}
      className={cn("w-full", component.className)}
      style={component.style as React.CSSProperties}
    >
      <TabsList className="w-full justify-start overflow-x-auto">
        {component.tabs.map((tab) => {
          const Icon = resolveIcon(tab.icon)
          return (
            <TabsTrigger key={tab.id} value={tab.id} disabled={tab.disabled}>
              {Icon && <Icon className="size-4" aria-hidden="true" />}
              {tab.label}
            </TabsTrigger>
          )
        })}
      </TabsList>
      {component.tabs.map((tab) => (
        <TabsContent key={tab.id} value={tab.id} className="min-w-0">
          <A2UIChildRenderer childIds={tab.children} />
        </TabsContent>
      ))}
    </Tabs>
  )
})
