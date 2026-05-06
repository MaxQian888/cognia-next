"use client"

import React, { memo, useCallback } from "react"
import { cn } from "@/lib/utils"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { Label } from "@/components/ui/label"
import { useA2UIData } from "../a2ui-context"
import { getBindingPath } from "@/lib/a2ui/data-model"
import type { A2UIComponentProps, A2UIBaseComponent } from "@/types/a2ui/schema"

export interface A2UIToggleGroupOption {
  value: string
  label: string
  disabled?: boolean
}

export interface A2UIToggleGroupComponent extends A2UIBaseComponent {
  component: "ToggleGroup"
  options: A2UIToggleGroupOption[]
  value: string[] | A2UIPathValue<string[]>
  label?: string
  multiple?: boolean
  size?: "sm" | "default" | "lg"
}

export const A2UIToggleGroup = memo(function A2UIToggleGroup({
  component,
  onDataChange,
}: A2UIComponentProps<A2UIToggleGroupComponent>) {
  const { resolveArray } = useA2UIData()
  const value = resolveArray<string>(component.value, [])
  const bindingPath = getBindingPath(component.value)

  const handleChange = useCallback(
    (newValue: string | string[]) => {
      if (bindingPath) {
        onDataChange(bindingPath, Array.isArray(newValue) ? newValue : [newValue])
      }
    },
    [bindingPath, onDataChange]
  )

  return (
    <div
      className={cn("space-y-1.5", component.className)}
      style={component.style as React.CSSProperties}
    >
      {component.label && <Label>{component.label}</Label>}
      <ToggleGroup
        type={component.multiple !== false ? "multiple" : "single"}
        value={component.multiple !== false ? value : value}
        onValueChange={handleChange}
        size={component.size || "default"}
      >
        {component.options.map((opt) => (
          <ToggleGroupItem key={opt.value} value={opt.value} disabled={opt.disabled}>
            {opt.label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
    </div>
  )
})
