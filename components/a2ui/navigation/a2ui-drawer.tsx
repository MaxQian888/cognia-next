"use client"

import React, { memo, useState } from "react"
import { cn } from "@/lib/utils"
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "@/components/ui/drawer"
import type {
  A2UIComponentProps,
  A2UIBaseComponent,
  A2UIStringOrPath,
  A2UIBooleanOrPath,
} from "@/types/a2ui/schema"
import { useA2UIData } from "../a2ui-context"

export interface A2UIDrawerComponent extends A2UIBaseComponent {
  component: "Drawer"
  trigger: string
  title?: A2UIStringOrPath
  description?: A2UIStringOrPath
  children: string[]
  open?: A2UIBooleanOrPath
}

export const A2UIDrawer = memo(function A2UIDrawer({
  component,
  renderChild,
}: A2UIComponentProps<A2UIDrawerComponent>) {
  const { resolveString, resolveBoolean } = useA2UIData()
  const title = component.title ? resolveString(component.title) : undefined
  const description = component.description ? resolveString(component.description) : undefined
  const controlledOpen = component.open ? resolveBoolean(component.open) : undefined
  const [internalOpen, setInternalOpen] = useState(false)

  return (
    <Drawer open={controlledOpen ?? internalOpen} onOpenChange={setInternalOpen}>
      <DrawerTrigger asChild>
        <span
          className={cn("inline-flex", component.className)}
          style={component.style as React.CSSProperties}
        >
          {renderChild(component.trigger)}
        </span>
      </DrawerTrigger>
      <DrawerContent>
        {(title || description) && (
          <DrawerHeader>
            {title && <DrawerTitle>{title}</DrawerTitle>}
            {description && <DrawerDescription>{description}</DrawerDescription>}
          </DrawerHeader>
        )}
        {component.children.map((childId) => (
          <React.Fragment key={childId}>{renderChild(childId)}</React.Fragment>
        ))}
      </DrawerContent>
    </Drawer>
  )
})
