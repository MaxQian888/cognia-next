"use client"

/**
 * A2UI Toggle Component
 * Maps to shadcn/ui Toggle for binary state toggling
 */

import React, { memo } from "react"
import { cn } from "@/lib/utils"
import { Toggle } from "@/components/ui/toggle"
import type { A2UIComponentProps, A2UIToggleComponent } from "@/types/a2ui/schema"
import { useA2UIData } from "../a2ui-context"
import { resolveStringOrPath, resolveBooleanOrPath } from "@/lib/a2ui/data-model"

export const A2UIToggle = memo(function A2UIToggle({
  component,
  onAction,
  onDataChange,
}: A2UIComponentProps<A2UIToggleComponent>) {
  const { dataModel } = useA2UIData()

  const label = component.label ? resolveStringOrPath(component.label, dataModel, "") : ""
  const pressed = component.pressed
    ? resolveBooleanOrPath(component.pressed, dataModel, false)
    : false

  const handlePressedChange = (newPressed: boolean) => {
    // Update data model if bound
    if (component.pressed && typeof component.pressed === "object" && "path" in component.pressed) {
      onDataChange(component.pressed.path, newPressed)
    }
    // Fire action
    if (component.action) {
      onAction(component.action, { pressed: newPressed })
    }
  }

  return (
    <Toggle
      variant={component.variant || "default"}
      size={component.size || "default"}
      pressed={pressed}
      onPressedChange={handlePressedChange}
      disabled={
        component.disabled != null
          ? resolveBooleanOrPath(component.disabled, dataModel, false)
          : false
      }
      className={cn(component.className)}
      style={component.style as React.CSSProperties}
      aria-label={label || component.id}
    >
      {label}
    </Toggle>
  )
})
