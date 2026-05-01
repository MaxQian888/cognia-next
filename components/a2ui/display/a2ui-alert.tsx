"use client"

/**
 * A2UI Alert Component
 * Maps to shadcn/ui Alert
 */

import React, { memo } from "react"
import { cn } from "@/lib/utils"
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert"
import { AlertCircle, CheckCircle, Info, AlertTriangle, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { A2UIComponentProps, A2UIAlertComponent } from "@/types/a2ui/schema"
import { useA2UIData } from "../a2ui-context"

const variantIcons = {
  default: Info,
  info: Info,
  success: CheckCircle,
  warning: AlertTriangle,
  error: AlertCircle,
  destructive: AlertCircle,
}

const variantStyles = {
  default: "",
  info: "border-blue-200 bg-blue-50 text-blue-900 dark:border-blue-800 dark:bg-blue-950 dark:text-blue-100",
  success:
    "border-green-200 bg-green-50 text-green-900 dark:border-green-800 dark:bg-green-950 dark:text-green-100",
  warning:
    "border-yellow-200 bg-yellow-50 text-yellow-900 dark:border-yellow-800 dark:bg-yellow-950 dark:text-yellow-100",
  error:
    "border-red-200 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950 dark:text-red-100",
  destructive: "",
}

export const A2UIAlert = memo(function A2UIAlert({
  component,
  onAction,
}: A2UIComponentProps<A2UIAlertComponent>) {
  const { resolveString } = useA2UIData()

  const title = component.title ? resolveString(component.title, "") : ""
  const message = resolveString(component.message, "")
  const variant = component.variant || "default"
  const showIcon = component.showIcon !== false
  const dismissible = component.dismissible || false

  const Icon = variantIcons[variant] || Info

  const handleDismiss = () => {
    if (component.dismissAction) {
      onAction(component.dismissAction, {})
    }
  }

  return (
    <Alert
      variant={variant === "destructive" || variant === "error" ? "destructive" : "default"}
      className={cn(variantStyles[variant], dismissible && "pr-10", component.className)}
      style={component.style as React.CSSProperties}
    >
      {showIcon && <Icon className="h-4 w-4" />}
      <div className="flex-1">
        {title && <AlertTitle>{title}</AlertTitle>}
        <AlertDescription>{message}</AlertDescription>
      </div>
      {dismissible && (
        <Button
          variant="ghost"
          size="icon"
          className="absolute right-2 top-2 h-6 w-6"
          onClick={handleDismiss}
        >
          <X className="h-4 w-4" />
        </Button>
      )}
    </Alert>
  )
})
