"use client"

/**
 * A2UI Form Group Component
 * Groups form fields with validation and layout options
 */

import React, { memo, useMemo } from "react"
import { cn } from "@/lib/utils"
import type { A2UIComponentProps, A2UIBaseComponent } from "@/types/a2ui/schema"
import { A2UIChildRenderer } from "../a2ui-renderer"
import { useA2UIForm, type ValidationRule } from "@/hooks/a2ui/use-a2ui-form"

export interface A2UIFormGroupComponent extends A2UIBaseComponent {
  component: "FormGroup"
  children: string[]
  legend?: string
  description?: string
  layout?: "vertical" | "horizontal" | "grid"
  columns?: number
  gap?: number | string
  required?: boolean
  validationRules?: Record<string, ValidationRule>
  onSubmit?: (values: Record<string, unknown>) => void
}

export const A2UIFormGroup = memo(function A2UIFormGroup({
  component,
  onAction,
}: A2UIComponentProps<A2UIFormGroupComponent>) {
  const validationRules = useMemo(
    () => component.validationRules || {},
    [component.validationRules]
  )

  const form = useA2UIForm({
    validationRules,
    onSubmit: (values) => {
      onAction?.("formSubmit", { values })
      component.onSubmit?.(values)
    },
  })

  const layout = component.layout || "vertical"
  const columns = component.columns || 2
  const gap = component.gap || 4

  const gapClass = typeof gap === "number" ? `gap-${gap}` : ""
  const gapStyle = typeof gap === "string" ? { gap } : {}

  const layoutClasses = {
    vertical: "flex flex-col",
    horizontal: "flex flex-row flex-wrap items-start",
    grid: `grid grid-cols-${columns}`,
  }

  return (
    <fieldset
      className={cn("space-y-4", component.className)}
      style={component.style as React.CSSProperties}
      aria-invalid={!form.isValid && form.isDirty}
    >
      {component.legend && (
        <legend className="text-sm font-medium leading-none peer-disabled:cursor-not-allowed peer-disabled:opacity-70">
          {component.legend}
          {component.required && <span className="text-destructive ml-1">*</span>}
        </legend>
      )}
      {component.description && (
        <p className="text-sm text-muted-foreground">{component.description}</p>
      )}
      <div className={cn(layoutClasses[layout], gapClass)} style={gapStyle}>
        <A2UIChildRenderer childIds={component.children} />
      </div>
    </fieldset>
  )
})
