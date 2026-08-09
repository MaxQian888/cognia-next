"use client"

/**
 * A2UI Error Component
 * Displays error states with retry functionality
 */

import React, { memo } from "react"
import { cn } from "@/lib/utils"
import { AlertCircle, RefreshCw } from "lucide-react"
import { ErrorTraceDetails } from "@/components/error/error-trace-details"
import { Button } from "@/components/ui/button"
import { Alert, AlertTitle, AlertDescription } from "@/components/ui/alert"
import type { A2UIComponentProps, A2UIBaseComponent } from "@/types/a2ui/schema"

export interface A2UIErrorComponent extends A2UIBaseComponent {
  component: "Error"
  title?: string
  message: string
  retryAction?: string
  retryLabel?: string
  variant?: "inline" | "card" | "fullpage"
}

export const A2UIError = memo(function A2UIError({
  component,
  onAction,
}: A2UIComponentProps<A2UIErrorComponent>) {
  const variant = component.variant || "inline"
  const shouldUseTraceDetails =
    component.message.includes("\n") ||
    component.message.includes(" at ") ||
    component.message.includes("Error:")

  // When the message looks like a stack trace, peel the first line off as the
  // human-facing summary and feed the rest of the lines to ErrorTraceDetails
  // as the stack — that way the collapsible can hide the noisy frame lines.
  const traceMessage = (() => {
    if (!shouldUseTraceDetails) return component.message
    const firstLineBreak = component.message.indexOf("\n")
    let firstLine =
      firstLineBreak === -1 ? component.message : component.message.slice(0, firstLineBreak)
    // Strip a leading "Error: " prefix so the headline reads naturally.
    firstLine = firstLine.replace(/^Error:\s*/, "")
    return firstLine
  })()
  const traceStack = (() => {
    if (!shouldUseTraceDetails) return undefined
    const firstLineBreak = component.message.indexOf("\n")
    if (firstLineBreak === -1) return undefined
    return component.message.slice(firstLineBreak + 1)
  })()

  const handleRetry = () => {
    if (component.retryAction) {
      onAction(component.retryAction, {})
    }
  }

  const content = (
    <>
      <AlertCircle
        className={cn("text-destructive", variant === "fullpage" ? "h-12 w-12" : "h-5 w-5")}
      />
      <div className="flex flex-col gap-1">
        {component.title && (
          <h3
            className={cn(
              "font-semibold text-destructive",
              variant === "fullpage" ? "text-lg" : "text-sm"
            )}
          >
            {component.title}
          </h3>
        )}
        {shouldUseTraceDetails ? (
          <ErrorTraceDetails error={{ message: traceMessage, stack: traceStack }} />
        ) : (
          <p
            className={cn(
              "text-muted-foreground",
              variant === "fullpage" ? "text-base" : "text-sm"
            )}
          >
            {component.message}
          </p>
        )}
      </div>
      {component.retryAction && (
        <Button
          variant="outline"
          size={variant === "fullpage" ? "default" : "sm"}
          onClick={handleRetry}
          className="mt-2"
        >
          <RefreshCw className="mr-2 h-4 w-4" />
          {component.retryLabel || "Retry"}
        </Button>
      )}
    </>
  )

  if (variant === "fullpage") {
    return (
      <div
        className={cn(
          "flex min-h-[200px] flex-col items-center justify-center gap-4 p-8 text-center",
          component.className
        )}
        style={component.style as React.CSSProperties}
        role="alert"
      >
        {content}
      </div>
    )
  }

  if (variant === "card") {
    return (
      <Alert
        variant="destructive"
        className={cn(
          "text-center [&>svg]:static [&>svg]:translate-y-0 flex flex-col items-center gap-3",
          component.className
        )}
        style={component.style as React.CSSProperties}
      >
        <AlertCircle className="h-5 w-5" />
        {component.title && <AlertTitle>{component.title}</AlertTitle>}
        <AlertDescription>{component.message}</AlertDescription>
        {component.retryAction && (
          <Button variant="outline" size="sm" onClick={handleRetry} className="mt-2">
            <RefreshCw className="mr-2 h-4 w-4" />
            {component.retryLabel || "Retry"}
          </Button>
        )}
      </Alert>
    )
  }

  // Inline variant
  return (
    <div
      className={cn("flex items-start gap-2 text-sm", component.className)}
      style={component.style as React.CSSProperties}
      role="alert"
    >
      {content}
    </div>
  )
})
