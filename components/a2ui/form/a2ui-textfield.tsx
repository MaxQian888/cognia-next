"use client"

/**
 * A2UI TextField Component
 * Maps to shadcn/ui Input with Label
 */

import React, { useCallback, memo, useContext } from "react"
import { cn } from "@/lib/utils"
import { Input } from "@/components/ui/input"
import { A2UIInputGroupContext } from "./a2ui-input-group"
import { InputGroupInput, InputGroupAddon } from "@/components/ui/input-group"
import { Label } from "@/components/ui/label"
import type { A2UIComponentProps, A2UITextFieldComponent } from "@/types/a2ui/schema"
import { useA2UIData } from "../a2ui-context"
import { getBindingPath } from "@/lib/a2ui/data-model"

export const A2UITextField = memo(function A2UITextField({
  component,
  onDataChange,
}: A2UIComponentProps<A2UITextFieldComponent>) {
  const { resolveString, resolveBoolean } = useA2UIData()

  const grouped = useContext(A2UIInputGroupContext)
  const Control = grouped ? InputGroupInput : Input
  const value = resolveString(component.value, "")
  const error = component.error ? resolveString(component.error, "") : ""
  const isDisabled = component.disabled ? resolveBoolean(component.disabled, false) : false
  const bindingPath = getBindingPath(component.value)

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (bindingPath) {
        onDataChange(bindingPath, e.target.value)
      }
    },
    [bindingPath, onDataChange]
  )

  const control = (
    <Control
      id={component.id}
      type={component.type || "text"}
      value={value}
      onChange={handleChange}
      placeholder={component.placeholder}
      disabled={isDisabled}
      required={component.required}
      minLength={component.minLength}
      maxLength={component.maxLength}
      pattern={component.pattern}
      className={cn(
        "min-h-[44px] sm:min-h-[40px] text-base sm:text-sm",
        error && "border-destructive"
      )}
    />
  )
  if (grouped)
    return (
      <>
        {component.label && (
          <InputGroupAddon align="block-start">
            <Label htmlFor={component.id}>{component.label}</Label>
          </InputGroupAddon>
        )}
        {control}
        {(error || component.helperText) && (
          <InputGroupAddon align="block-end">{error || component.helperText}</InputGroupAddon>
        )}
      </>
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
      {control}
      {(error || component.helperText) && (
        <p className={cn("text-sm", error ? "text-destructive" : "text-muted-foreground")}>
          {error || component.helperText}
        </p>
      )}
    </div>
  )
})
