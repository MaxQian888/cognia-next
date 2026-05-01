"use client"

/**
 * A2UI Switch Component
 * Toggle switch for boolean values
 */

import React, { useCallback, memo } from "react"
import { cn } from "@/lib/utils"
import { Switch } from "@/components/ui/switch"
import { Label } from "@/components/ui/label"
import type { A2UIComponentProps, A2UIBaseComponent } from "@/types/a2ui/schema"
import { useA2UIData } from "../a2ui-context"
import { getBindingPath } from "@/lib/a2ui/data-model"

export interface A2UISwitchComponent extends A2UIBaseComponent {
  component: "Switch"
  checked: boolean | { path: string }
  label?: string
  description?: string
  disabled?: boolean | { path: string }
}

export const A2UISwitch = memo(function A2UISwitch({
  component,
  onDataChange,
}: A2UIComponentProps<A2UISwitchComponent>) {
  const { resolveBoolean } = useA2UIData()

  const checked = resolveBoolean(component.checked, false)
  const isDisabled = component.disabled ? resolveBoolean(component.disabled, false) : false
  const bindingPath = getBindingPath(component.checked)

  const handleChange = useCallback(
    (newChecked: boolean) => {
      if (bindingPath) {
        onDataChange(bindingPath, newChecked)
      }
    },
    [bindingPath, onDataChange]
  )

  return (
    <div
      className={cn("flex items-center justify-between gap-4", component.className)}
      style={component.style as React.CSSProperties}
    >
      <div className="space-y-0.5">
        {component.label && (
          <Label
            htmlFor={component.id}
            className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70"
          >
            {component.label}
          </Label>
        )}
        {component.description && (
          <p className="text-sm text-muted-foreground">{component.description}</p>
        )}
      </div>
      <Switch
        id={component.id}
        checked={checked}
        onCheckedChange={handleChange}
        disabled={isDisabled}
      />
    </div>
  )
})
