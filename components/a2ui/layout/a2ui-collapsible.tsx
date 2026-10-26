"use client"

import React, { memo, useState } from "react"
import { cn } from "@/lib/utils"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import type {
  A2UIComponentProps,
  A2UIBaseComponent,
  A2UIStringOrPath,
  A2UIBooleanOrPath,
} from "@/types/a2ui/schema"
import { getBindingPath } from "@/lib/a2ui/data-model"
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
  onDataChange,
}: A2UIComponentProps<A2UICollapsibleComponent>) {
  const { resolveString, resolveBoolean } = useA2UIData()
  const title = resolveString(component.title)
  const [internalOpen, setInternalOpen] = useState(false)
  const open = component.open !== undefined ? resolveBoolean(component.open) : internalOpen
  const path = getBindingPath(component.open)

  return (
    <Collapsible
      open={open}
      onOpenChange={(value) => {
        if (path) onDataChange(path, value)
        else setInternalOpen(value)
      }}
      disabled={resolveBoolean(component.disabled ?? false, false)}
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
