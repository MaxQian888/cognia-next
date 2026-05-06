"use client"

import React, { memo } from "react"
import { cn } from "@/lib/utils"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import type {
  A2UIComponentProps,
  A2UIBaseComponent,
  A2UIStringOrPath,
  A2UIBooleanOrPath,
} from "@/types/a2ui/schema"
import { useA2UIData } from "../a2ui-context"

export interface A2UICollapsibleComponent extends A2UIBaseComponent {
  component: "Collapsible"
  title: A2UIStringOrPath
  children: string[]
  open?: A2UIBooleanOrPath
}

export const A2UICollapsible = memo(function A2UICollapsible({
  component,
  renderChild,
}: A2UIComponentProps<A2UICollapsibleComponent>) {
  const { resolveString, resolveBoolean } = useA2UIData()
  const title = resolveString(component.title)
  const open = component.open ? resolveBoolean(component.open) : undefined

  return (
    <Collapsible
      defaultOpen={open ?? false}
      className={cn("space-y-2", component.className)}
      style={component.style as React.CSSProperties}
    >
      <CollapsibleTrigger className="flex items-center gap-2 text-sm font-medium hover:underline">
        {title}
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-2">
        {component.children.map((childId) => (
          <React.Fragment key={childId}>{renderChild(childId)}</React.Fragment>
        ))}
      </CollapsibleContent>
    </Collapsible>
  )
})
