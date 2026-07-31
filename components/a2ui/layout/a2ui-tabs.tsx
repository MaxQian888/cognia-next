"use client"

/**
 * A2UI Tabs Component
 * Maps to shadcn/ui Tabs for tabbed content
 */

import React, { useState, memo } from "react"
import { cn } from "@/lib/utils"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import type { A2UIComponentProps, A2UITabsComponent } from "@/types/a2ui/schema"
import { useA2UIData } from "../a2ui-context"
import { resolveStringOrPath } from "@/lib/a2ui/data-model"
import { A2UIChildRenderer } from "../a2ui-child-renderer"

export const A2UITabs = memo(function A2UITabs({
  component,
  onAction,
}: A2UIComponentProps<A2UITabsComponent>) {
  const { dataModel } = useA2UIData()

  const activeTabFromData = component.activeTab
    ? resolveStringOrPath(component.activeTab, dataModel, "")
    : ""

  const defaultTab = component.defaultTab || component.tabs[0]?.id || ""
  const [activeTab, setActiveTab] = useState(activeTabFromData || defaultTab)

  const handleTabChange = (value: string) => {
    setActiveTab(value)
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
        {component.tabs.map((tab) => (
          <TabsTrigger key={tab.id} value={tab.id} disabled={tab.disabled}>
            {tab.label}
          </TabsTrigger>
        ))}
      </TabsList>
      {component.tabs.map((tab) => (
        <TabsContent key={tab.id} value={tab.id} className="min-w-0">
          <A2UIChildRenderer childIds={tab.children} />
        </TabsContent>
      ))}
    </Tabs>
  )
})
