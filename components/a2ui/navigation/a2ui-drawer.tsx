"use client"

import { useTranslations } from "next-intl"
import { getBindingPath } from "@/lib/a2ui/data-model"
import React, { memo, useState } from "react"
import { A2UITrigger } from "../a2ui-child-renderer"
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
  onDataChange,
}: A2UIComponentProps<A2UIDrawerComponent>) {
  const t = useTranslations("a2ui.controls")
  const { resolveString, resolveBoolean } = useA2UIData()
  const title = component.title ? resolveString(component.title) : undefined
  const description = component.description ? resolveString(component.description) : undefined
  const controlledOpen = component.open !== undefined ? resolveBoolean(component.open) : undefined
  const [internalOpen, setInternalOpen] = useState(false)

  const bindingPath = getBindingPath(component.open)
  const handleOpenChange = (open: boolean) => {
    if (bindingPath) onDataChange(bindingPath, open)
    else setInternalOpen(open)
  }

  return (
    <Drawer open={controlledOpen ?? internalOpen} onOpenChange={handleOpenChange}>
      <DrawerTrigger asChild>
        <A2UITrigger
          componentId={component.trigger}
          renderChild={renderChild}
          className={component.className}
          style={component.style as React.CSSProperties}
        />
      </DrawerTrigger>
      <DrawerContent>
        <DrawerHeader>
          <DrawerTitle className={title ? undefined : "sr-only"}>
            {title || t("untitled")}
          </DrawerTitle>
          {description && <DrawerDescription>{description}</DrawerDescription>}
        </DrawerHeader>
        {component.children.map((childId) => (
          <React.Fragment key={childId}>{renderChild(childId)}</React.Fragment>
        ))}
      </DrawerContent>
    </Drawer>
  )
})
