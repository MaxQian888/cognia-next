"use client"

/**
 * A2UI Select Component
 * Maps to shadcn/ui Select
 */

import React, { useCallback, memo } from "react"
import { useTranslations } from "next-intl"
import { cn } from "@/lib/utils"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Label } from "@/components/ui/label"
import type { A2UIComponentProps, A2UISelectComponent, A2UISelectOption } from "@/types/a2ui/schema"
import { useA2UIData } from "../a2ui-context"
import { getBindingPath, resolveArrayOrPath } from "@/lib/a2ui/data-model"

export const A2UISelect = memo(function A2UISelect({
  component,
  onDataChange,
}: A2UIComponentProps<A2UISelectComponent>) {
  const t = useTranslations("a2ui")
  const { resolveString, resolveBoolean, dataModel } = useA2UIData()

  const value = resolveString(component.value, "")
  const error = component.error ? resolveString(component.error, "") : ""
  const isDisabled = component.disabled ? resolveBoolean(component.disabled, false) : false
  const bindingPath = getBindingPath(component.value)

  // Resolve options - can be static array or data-bound
  const options: A2UISelectOption[] = Array.isArray(component.options)
    ? component.options
    : resolveArrayOrPath<A2UISelectOption>(component.options, dataModel, [])

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
      {component.label && (
        <Label htmlFor={component.id} className={error ? "text-destructive" : ""}>
          {component.label}
          {component.required && <span className="text-destructive ml-1">*</span>}
        </Label>
      )}
      <Select value={value} onValueChange={handleChange} disabled={isDisabled}>
        <SelectTrigger id={component.id} className={error ? "border-destructive" : ""}>
          <SelectValue placeholder={component.placeholder || t("selectPlaceholder")} />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value} disabled={option.disabled}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {(error || component.helperText) && (
        <p className={cn("text-sm", error ? "text-destructive" : "text-muted-foreground")}>
          {error || component.helperText}
        </p>
      )}
    </div>
  )
})
