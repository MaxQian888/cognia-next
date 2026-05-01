"use client"

/**
 * A2UI Button Component
 * Maps to shadcn/ui Button
 */

import React, { memo } from "react"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Loader2 } from "lucide-react"
import type { A2UIComponentProps, A2UIButtonComponent } from "@/types/a2ui/schema"
import { useA2UIData } from "../a2ui-context"

const variantMap: Record<
  string,
  "default" | "destructive" | "outline" | "secondary" | "ghost" | "link"
> = {
  default: "default",
  primary: "default",
  secondary: "secondary",
  destructive: "destructive",
  outline: "outline",
  ghost: "ghost",
  link: "link",
}

export const A2UIButton = memo(function A2UIButton({
  component,
  onAction,
}: A2UIComponentProps<A2UIButtonComponent>) {
  const { resolveString, resolveBoolean } = useA2UIData()

  const text = resolveString(component.text, "")
  const isLoading = component.loading ? resolveBoolean(component.loading, false) : false
  const isDisabled = component.disabled ? resolveBoolean(component.disabled, false) : false
  const variant = variantMap[component.variant || "default"] || "default"

  const handleClick = () => {
    if (!isDisabled && !isLoading && component.action) {
      onAction(component.action, { text })
    }
  }

  return (
    <Button
      variant={variant}
      disabled={isDisabled || isLoading}
      onClick={handleClick}
      className={cn(component.className)}
      style={component.style as React.CSSProperties}
    >
      {isLoading && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
      {text}
    </Button>
  )
})
