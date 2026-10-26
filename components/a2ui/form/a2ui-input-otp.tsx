"use client"

import React, { memo, useCallback } from "react"
import { cn } from "@/lib/utils"
import { InputOTP, InputOTPGroup, InputOTPSlot } from "@/components/ui/input-otp"
import { Label } from "@/components/ui/label"
import { useA2UIData } from "../a2ui-context"
import { getBindingPath } from "@/lib/a2ui/data-model"
import type { A2UIComponentProps, A2UIBaseComponent, A2UIStringOrPath } from "@/types/a2ui/schema"

export interface A2UIInputOTPComponent extends A2UIBaseComponent {
  component: "InputOTP"
  value: A2UIStringOrPath
  maxLength?: number
  label?: string
  disabled?: boolean
}

export const A2UIInputOTP = memo(function A2UIInputOTP({
  component,
  onDataChange,
}: A2UIComponentProps<A2UIInputOTPComponent>) {
  const { resolveString, resolveBoolean } = useA2UIData()
  const value = resolveString(component.value)
  const disabled = resolveBoolean(component.disabled ?? false, false)
  const bindingPath = getBindingPath(component.value)
  const maxLength = component.maxLength || 6

  const handleChange = useCallback(
    (newValue: string) => {
      if (!disabled && bindingPath) {
        onDataChange(bindingPath, newValue)
      }
    },
    [bindingPath, disabled, onDataChange]
  )

  return (
    <div
      className={cn("space-y-1.5", component.className)}
      style={component.style as React.CSSProperties}
    >
      {component.label && <Label htmlFor={component.id}>{component.label}</Label>}
      <InputOTP
        id={component.id}
        maxLength={maxLength}
        value={value}
        onChange={handleChange}
        disabled={disabled}
      >
        <InputOTPGroup>
          {Array.from({ length: maxLength }).map((_, i) => (
            <InputOTPSlot key={i} index={i} />
          ))}
        </InputOTPGroup>
      </InputOTP>
    </div>
  )
})
