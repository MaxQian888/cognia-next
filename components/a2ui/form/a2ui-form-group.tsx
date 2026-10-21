"use client"

/**
 * A2UI Form Group Component
 * Groups form fields with validation and layout options
 */

import React, { memo, useMemo, useState, useContext } from "react"
import { cn } from "@/lib/utils"
import type { A2UIComponentProps, A2UIBaseComponent } from "@/types/a2ui/schema"
import { A2UIChildRenderer } from "../a2ui-child-renderer"
import type { ValidationRule } from "@/hooks/a2ui/use-a2ui-form"
import { A2UIDataCtx } from "@/hooks/a2ui/use-a2ui-context"
import { getValueByPath } from "@/lib/a2ui/data-model"
import { Button } from "@/components/ui/button"
import { useTranslations } from "next-intl"

export interface A2UIFormGroupComponent extends A2UIBaseComponent {
  component: "FormGroup"
  children: string[]
  legend?: string
  description?: string
  layout?: "vertical" | "horizontal" | "grid"
  columns?: number
  gap?: number | string
  required?: boolean
  validationRules?: Record<
    string,
    Omit<ValidationRule, "pattern"> & {
      pattern?: { value: string | RegExp; message: string }
    }
  >
  submitAction?: string
  submitLabel?: string
  onSubmit?: (values: Record<string, unknown>) => void
}

export const A2UIFormGroup = memo(function A2UIFormGroup({
  component,
  dataModel: dataModelProp,
  onAction,
}: A2UIComponentProps<A2UIFormGroupComponent>) {
  const t = useTranslations("a2ui.controls")
  const context = useContext(A2UIDataCtx)
  const values = context?.dataModel ?? dataModelProp
  const disabled =
    context?.resolveBoolean(component.disabled ?? false, false) ?? component.disabled === true
  const [submitted, setSubmitted] = useState(false)
  const errors = useMemo(() => {
    const errors: Record<string, string> = {}
    for (const [name, rule] of Object.entries(component.validationRules ?? {})) {
      const value = name.startsWith("/") ? getValueByPath(values, name) : values[name]
      if (rule.required && (value === undefined || value === null || value === "")) {
        errors[name] = typeof rule.required === "string" ? rule.required : t("required")
      } else if (typeof value === "string") {
        if (rule.minLength && value.length < rule.minLength.value)
          errors[name] = rule.minLength.message
        else if (rule.maxLength && value.length > rule.maxLength.value)
          errors[name] = rule.maxLength.message
        else if (rule.pattern) {
          try {
            if (!new RegExp(rule.pattern.value).test(value)) errors[name] = rule.pattern.message
          } catch {
            errors[name] = rule.pattern.message
          }
        }
      }
      if (!errors[name] && rule.custom) {
        const error = rule.custom(value)
        if (error) errors[name] = error
      }
    }
    return errors
  }, [component.validationRules, values, t])
  const handleSubmit = () => {
    if (disabled) return
    setSubmitted(true)
    if (Object.keys(errors).length > 0) return
    onAction(component.submitAction || "formSubmit", { values })
    component.onSubmit?.(values)
  }

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
      disabled={disabled}
      className={cn("space-y-4", component.className)}
      style={component.style as React.CSSProperties}
      aria-invalid={submitted && Object.keys(errors).length > 0}
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
      {submitted && Object.keys(errors).length > 0 && (
        <div role="alert">
          {Object.entries(errors).map(([name, error]) => (
            <p key={name}>{error}</p>
          ))}
        </div>
      )}
      <Button type="button" disabled={disabled} onClick={handleSubmit}>
        {component.submitLabel || t("submit")}
      </Button>
    </fieldset>
  )
})
