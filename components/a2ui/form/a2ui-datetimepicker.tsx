"use client"

/**
 * A2UI DateTimePicker Component
 * Combined date and time selection
 */

import { format, isValid, parseISO } from "date-fns"
import React, { memo } from "react"
import { cn } from "@/lib/utils"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { CalendarClock } from "lucide-react"
import type { A2UIComponentProps, A2UIDateTimePickerComponent } from "@/types/a2ui/schema"
import { useA2UIData } from "../a2ui-context"
import { getBindingPath } from "@/lib/a2ui/data-model"

export const A2UIDateTimePicker = memo(function A2UIDateTimePicker({
  component,
  onDataChange,
}: A2UIComponentProps<A2UIDateTimePickerComponent>) {
  const { resolveString, resolveBoolean } = useA2UIData()

  const value = resolveString(component.value, "")
  const bindingPath = getBindingPath(component.value)

  // Convert ISO string to datetime-local format
  const toLocalInput = (value: string | undefined) => {
    if (!value) return ""
    const parsed = parseISO(value)
    return isValid(parsed) ? format(parsed, "yyyy-MM-dd'T'HH:mm") : ""
  }
  const formattedValue = toLocalInput(value)
  const disabled = resolveBoolean(component.disabled ?? false, false)

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (!disabled && bindingPath) {
      // Convert back to ISO format
      const isoValue = e.target.value ? new Date(e.target.value).toISOString() : ""
      onDataChange(bindingPath, isoValue)
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
        <CalendarClock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground pointer-events-none" />
        <Input
          id={component.id}
          type="datetime-local"
          value={formattedValue}
          onChange={handleChange}
          placeholder={component.placeholder}
          disabled={disabled}
          required={component.required}
          min={toLocalInput(component.minDate)}
          max={toLocalInput(component.maxDate)}
          className="pl-10"
        />
      </div>
    </div>
  )
})
