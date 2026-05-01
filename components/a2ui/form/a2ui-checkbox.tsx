"use client"

/**
 * A2UI Checkbox Component
 * Maps to shadcn/ui Checkbox
 */

import React, { useCallback, memo } from "react"
import { cn } from "@/lib/utils"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import type { A2UIComponentProps, A2UICheckboxComponent } from "@/types/a2ui/schema"
import { useA2UIData } from "../a2ui-context"
import { getBindingPath } from "@/lib/a2ui/data-model"

export const A2UICheckbox = memo(function A2UICheckbox({
  component,
  onDataChange,
}: A2UIComponentProps<A2UICheckboxComponent>) {
  const { resolveBoolean } = useA2UIData()

  const checked = resolveBoolean(component.checked, false)
  const isDisabled = component.disabled ? resolveBoolean(component.disabled, false) : false
  const bindingPath = getBindingPath(component.checked)

  const handleChange = useCallback(
    (newChecked: boolean | "indeterminate") => {
      if (bindingPath && typeof newChecked === "boolean") {
        onDataChange(bindingPath, newChecked)
      }
    },
    [bindingPath, onDataChange]
  )

  return (
    <div
      className={cn("flex items-start space-x-2", component.className)}
      style={component.style as React.CSSProperties}
    >
      <Checkbox
        id={component.id}
        checked={checked}
        onCheckedChange={handleChange}
        disabled={isDisabled}
      />
      {(component.label || component.helperText) && (
        <div className="grid gap-1.5 leading-none">
          {component.label && (
            <Label
              htmlFor={component.id}
              className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
            >
              {component.label}
            </Label>
          )}
          {component.helperText && (
            <p className="text-sm text-muted-foreground">{component.helperText}</p>
          )}
        </div>
      )}
    </div>
  )
})
