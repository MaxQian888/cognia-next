"use client"

/**
 * A2UI Slider Component
 * Maps to shadcn/ui Slider
 */

import React, { useCallback, memo } from "react"
import { cn } from "@/lib/utils"
import { Slider } from "@/components/ui/slider"
import { Label } from "@/components/ui/label"
import type { A2UIComponentProps, A2UISliderComponent } from "@/types/a2ui/schema"
import { useA2UIData } from "../a2ui-context"
import { getBindingPath } from "@/lib/a2ui/data-model"

export const A2UISlider = memo(function A2UISlider({
  component,
  onDataChange,
}: A2UIComponentProps<A2UISliderComponent>) {
  const { resolveNumber, resolveBoolean } = useA2UIData()

  const value = resolveNumber(component.value, component.min ?? 0)
  const isDisabled = component.disabled ? resolveBoolean(component.disabled, false) : false
  const bindingPath = getBindingPath(component.value)

  const min = component.min ?? 0
  const max = component.max ?? 100
  const step = component.step ?? 1

  const handleChange = useCallback(
    (newValue: number[]) => {
      if (bindingPath && newValue.length > 0) {
        onDataChange(bindingPath, newValue[0])
      }
    },
    [bindingPath, onDataChange]
  )

  return (
    <div
      className={cn("space-y-2", component.className)}
      style={component.style as React.CSSProperties}
    >
      {component.label && (
        <div className="flex items-center justify-between">
          <Label className="text-sm font-medium">{component.label}</Label>
          {component.showValue && <span className="text-sm text-muted-foreground">{value}</span>}
        </div>
      )}
      <Slider
        id={component.id}
        value={[value]}
        onValueChange={handleChange}
        min={min}
        max={max}
        step={step}
        disabled={isDisabled}
      />
    </div>
  )
})
