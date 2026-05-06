"use client"

import React, { memo, useState } from "react"
import { cn } from "@/lib/utils"
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet"
import type {
  A2UIComponentProps,
  A2UIBaseComponent,
  A2UIStringOrPath,
  A2UIBooleanOrPath,
} from "@/types/a2ui/schema"
import { useA2UIData } from "../a2ui-context"

export interface A2UISheetComponent extends A2UIBaseComponent {
  component: "Sheet"
  trigger: string
  title?: A2UIStringOrPath
  description?: A2UIStringOrPath
  children: string[]
  side?: "top" | "right" | "bottom" | "left"
  open?: A2UIBooleanOrPath
}

export const A2UISheet = memo(function A2UISheet({
  component,
  renderChild,
}: A2UIComponentProps<A2UISheetComponent>) {
  const { resolveString, resolveBoolean } = useA2UIData()
  const title = component.title ? resolveString(component.title) : undefined
  const description = component.description ? resolveString(component.description) : undefined
  const controlledOpen = component.open ? resolveBoolean(component.open) : undefined
  const [internalOpen, setInternalOpen] = useState(false)

  return (
    <Sheet open={controlledOpen ?? internalOpen} onOpenChange={setInternalOpen}>
      <SheetTrigger asChild>
        <span
          className={cn("inline-flex", component.className)}
          style={component.style as React.CSSProperties}
        >
          {renderChild(component.trigger)}
        </span>
      </SheetTrigger>
      <SheetContent side={component.side || "right"}>
        {(title || description) && (
          <SheetHeader>
            {title && <SheetTitle>{title}</SheetTitle>}
            {description && <SheetDescription>{description}</SheetDescription>}
          </SheetHeader>
        )}
        {component.children.map((childId) => (
          <React.Fragment key={childId}>{renderChild(childId)}</React.Fragment>
        ))}
      </SheetContent>
    </Sheet>
  )
})
