"use client"

/**
 * A2UI TimePicker Component
 * Time selection input
 */

import React, { memo } from "react"
import { cn } from "@/lib/utils"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Clock } from "lucide-react"
import type { A2UIComponentProps, A2UITimePickerComponent } from "@/types/a2ui/schema"
import { useA2UIData } from "../a2ui-context"
import { getBindingPath } from "@/lib/a2ui/data-model"

export const A2UITimePicker = memo(function A2UITimePicker({
  component,
  onDataChange,
}: A2UIComponentProps<A2UITimePickerComponent>) {
  const { resolveString } = useA2UIData()

  const value = resolveString(component.value, "")
  const bindingPath = getBindingPath(component.value)

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (bindingPath) {
      onDataChange(bindingPath, e.target.value)
    }
  }

  return (
    <div
      className={cn("flex flex-col gap-1.5", component.className)}
      style={component.style as React.CSSProperties}
    >
      {component.label && (
        <Label htmlFor={component.id}>
          {component.label}
          {component.required && <span className="text-destructive ml-1">*</span>}
        </Label>
      )}
      <div className="relative">
        <Clock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
        <Input
          id={component.id}
          type="time"
          value={value}
          onChange={handleChange}
          placeholder={component.placeholder}
          disabled={component.disabled as boolean}
          required={component.required}
          className="pl-10"
        />
      </div>
    </div>
  )
})
