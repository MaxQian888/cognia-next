"use client"

/**
 * A2UI TextArea Component
 * Multi-line text input with data binding
 */

import React, { memo } from "react"
import { cn } from "@/lib/utils"
import { Textarea } from "@/components/ui/textarea"
import { Label } from "@/components/ui/label"
import type { A2UIComponentProps, A2UITextAreaComponent } from "@/types/a2ui/schema"
import { useA2UIData } from "../a2ui-context"
import { getBindingPath } from "@/lib/a2ui/data-model"

export const A2UITextArea = memo(function A2UITextArea({
  component,
  onDataChange,
}: A2UIComponentProps<A2UITextAreaComponent>) {
  const { resolveString } = useA2UIData()

  const value = resolveString(component.value, "")
  const error = component.error ? resolveString(component.error, "") : ""
  const bindingPath = getBindingPath(component.value)

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
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
        <Label htmlFor={component.id} className={cn(error && "text-destructive")}>
          {component.label}
          {component.required && <span className="text-destructive ml-1">*</span>}
        </Label>
      )}
      <Textarea
        id={component.id}
        value={value}
        onChange={handleChange}
        placeholder={component.placeholder}
        disabled={component.disabled as boolean}
        required={component.required}
        minLength={component.minLength}
        maxLength={component.maxLength}
        rows={component.rows || 3}
        className={cn(error && "border-destructive focus-visible:ring-destructive")}
      />
      {(error || component.helperText) && (
        <p className={cn("text-xs", error ? "text-destructive" : "text-muted-foreground")}>
          {error || component.helperText}
        </p>
      )}
    </div>
  )
})
