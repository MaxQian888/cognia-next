"use client"

import { useTranslations } from "next-intl"
import { getBindingPath } from "@/lib/a2ui/data-model"
import React, { memo, useState } from "react"
import { A2UITrigger } from "../a2ui-child-renderer"
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
  onDataChange,
}: A2UIComponentProps<A2UISheetComponent>) {
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
    <Sheet open={controlledOpen ?? internalOpen} onOpenChange={handleOpenChange}>
      <SheetTrigger asChild>
        <A2UITrigger
          componentId={component.trigger}
          renderChild={renderChild}
          className={component.className}
          style={component.style as React.CSSProperties}
        />
      </SheetTrigger>
      <SheetContent side={component.side || "right"}>
        <SheetHeader>
          <SheetTitle className={title ? undefined : "sr-only"}>
            {title || t("untitled")}
          </SheetTitle>
          {description && <SheetDescription>{description}</SheetDescription>}
        </SheetHeader>
        {component.children.map((childId) => (
          <React.Fragment key={childId}>{renderChild(childId)}</React.Fragment>
        ))}
      </SheetContent>
    </Sheet>
  )
})
