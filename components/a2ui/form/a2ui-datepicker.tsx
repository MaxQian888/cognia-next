"use client"

/**
 * A2UI DatePicker Component
 * Maps to shadcn/ui Calendar with Popover
 */

import React, { useCallback, useMemo, memo } from "react"
import { cn } from "@/lib/utils"
import { format, parseISO } from "date-fns"
import { Calendar as CalendarIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Calendar } from "@/components/ui/calendar"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { Label } from "@/components/ui/label"
import type { A2UIComponentProps, A2UIDatePickerComponent } from "@/types/a2ui/schema"
import { useA2UIData } from "../a2ui-context"
import { getBindingPath } from "@/lib/a2ui/data-model"

export const A2UIDatePicker = memo(function A2UIDatePicker({
  component,
  onDataChange,
}: A2UIComponentProps<A2UIDatePickerComponent>) {
  const { resolveString, resolveBoolean } = useA2UIData()

  const valueStr = resolveString(component.value, "")
  const isDisabled = component.disabled ? resolveBoolean(component.disabled, false) : false
  const bindingPath = getBindingPath(component.value)

  // Parse date from ISO string
  const date = useMemo(() => {
    if (!valueStr) return undefined
    try {
      return parseISO(valueStr)
    } catch {
      return undefined
    }
  }, [valueStr])

  // Parse min/max dates
  const minDate = useMemo(() => {
    if (!component.minDate) return undefined
    try {
      return parseISO(component.minDate)
    } catch {
      return undefined
    }
  }, [component.minDate])

  const maxDate = useMemo(() => {
    if (!component.maxDate) return undefined
    try {
      return parseISO(component.maxDate)
    } catch {
      return undefined
    }
  }, [component.maxDate])

  const handleSelect = useCallback(
    (newDate: Date | undefined) => {
      if (bindingPath) {
        onDataChange(bindingPath, newDate ? newDate.toISOString().split("T")[0] : "")
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
        <Label className="text-sm font-medium">
          {component.label}
          {component.required && <span className="text-destructive ml-1">*</span>}
        </Label>
      )}
      <Popover>
        <PopoverTrigger asChild>
          <Button
            id={component.id}
            variant="outline"
            disabled={isDisabled}
            className={cn(
              "w-full justify-start text-left font-normal",
              !date && "text-muted-foreground"
            )}
          >
            <CalendarIcon className="mr-2 h-4 w-4" />
            {date ? format(date, "PPP") : component.placeholder || "Pick a date"}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0" align="start">
          <Calendar
            mode="single"
            selected={date}
            onSelect={handleSelect}
            disabled={(d: Date) => {
              if (minDate && d < minDate) return true
              if (maxDate && d > maxDate) return true
              return false
            }}
            initialFocus
          />
        </PopoverContent>
      </Popover>
    </div>
  )
})
