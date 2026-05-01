"use client"

/**
 * A2UI RadioGroup Component
 * Maps to shadcn/ui RadioGroup
 */

import React, { useCallback, memo } from "react"
import { cn } from "@/lib/utils"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Label } from "@/components/ui/label"
import type {
  A2UIComponentProps,
  A2UIRadioComponent,
  A2UIRadioGroupComponent,
} from "@/types/a2ui/schema"
import { useA2UIData } from "../a2ui-context"
import { getBindingPath } from "@/lib/a2ui/data-model"

export const A2UIRadio = memo(function A2UIRadio({
  component,
  onDataChange,
}: A2UIComponentProps<A2UIRadioComponent>) {
  const { resolveBoolean } = useA2UIData()

  const checked = component.checked ? resolveBoolean(component.checked, false) : false
  const isDisabled = component.disabled ? resolveBoolean(component.disabled, false) : false
  const bindingPath = component.checked ? getBindingPath(component.checked) : null

  const handleChange = useCallback(
    (newValue: string) => {
      if (!bindingPath) {
        return
      }
      onDataChange(bindingPath, newValue === component.value)
    },
    [bindingPath, component.value, onDataChange]
  )

  return (
    <div
      className={cn("space-y-2", component.className)}
      style={component.style as React.CSSProperties}
    >
      <RadioGroup
        value={checked ? component.value : ""}
        onValueChange={handleChange}
        disabled={isDisabled}
      >
        <div className="flex items-center space-x-2">
          <RadioGroupItem
            value={component.value}
            id={component.id}
            aria-label={component.label ?? component.value}
          />
          {component.label && (
            <Label htmlFor={component.id} className="text-sm font-normal">
              {component.label}
            </Label>
          )}
        </div>
      </RadioGroup>
    </div>
  )
})

export const A2UIRadioGroup = memo(function A2UIRadioGroup({
  component,
  onDataChange,
}: A2UIComponentProps<A2UIRadioGroupComponent>) {
  const { resolveString, resolveBoolean } = useA2UIData()

  const value = resolveString(component.value, "")
  const isDisabled = component.disabled ? resolveBoolean(component.disabled, false) : false
  const bindingPath = getBindingPath(component.value)
  const orientation = component.orientation || "vertical"

  const handleChange = useCallback(
    (newValue: string) => {
      if (bindingPath) {
        onDataChange(bindingPath, newValue)
      }
    },
    [bindingPath, onDataChange]
  )

  return (
    <div
      className={cn("space-y-2", component.className)}
      style={component.style as React.CSSProperties}
    >
      {component.label && <Label className="text-sm font-medium">{component.label}</Label>}
      <RadioGroup
        value={value}
        onValueChange={handleChange}
        disabled={isDisabled}
        className={cn(orientation === "horizontal" ? "flex flex-row gap-4" : "flex flex-col gap-2")}
      >
        {component.options.map((option) => (
          <div key={option.value} className="flex items-center space-x-2">
            <RadioGroupItem
              value={option.value}
              id={`${component.id}-${option.value}`}
              disabled={option.disabled}
            />
            <Label htmlFor={`${component.id}-${option.value}`} className="text-sm font-normal">
              {option.label}
            </Label>
          </div>
        ))}
      </RadioGroup>
    </div>
  )
})
