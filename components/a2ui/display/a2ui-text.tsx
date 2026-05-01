"use client"

/**
 * A2UI Text Component
 * Renders text with various styling options
 */

import React, { memo } from "react"
import { cn } from "@/lib/utils"
import type { A2UIComponentProps, A2UITextComponent } from "@/types/a2ui/schema"
import { useA2UIData } from "../a2ui-context"

const variantStyles: Record<string, string> = {
  body: "text-base",
  heading1: "text-3xl font-bold tracking-tight",
  heading2: "text-2xl font-semibold tracking-tight",
  heading3: "text-xl font-semibold",
  heading4: "text-lg font-medium",
  caption: "text-sm text-muted-foreground",
  code: "font-mono text-sm bg-muted px-1 py-0.5 rounded",
  label: "text-sm font-medium",
}

const alignStyles: Record<string, string> = {
  left: "text-left",
  center: "text-center",
  right: "text-right",
}

export const A2UIText = memo(function A2UIText({
  component,
}: A2UIComponentProps<A2UITextComponent>) {
  const { resolveString } = useA2UIData()

  const text = resolveString(component.text, "")
  const variant = component.variant || "body"
  const align = component.align || "left"

  // Render based on variant
  const getElement = () => {
    const baseProps = {
      className: cn(variantStyles[variant], alignStyles[align], component.className),
      style: {
        ...(component.color ? { color: component.color } : {}),
        ...(component.style as React.CSSProperties),
      },
    }

    if (variant === "heading1") return <h1 {...baseProps}>{text}</h1>
    if (variant === "heading2") return <h2 {...baseProps}>{text}</h2>
    if (variant === "heading3") return <h3 {...baseProps}>{text}</h3>
    if (variant === "heading4") return <h4 {...baseProps}>{text}</h4>
    if (variant === "code") return <code {...baseProps}>{text}</code>
    return <p {...baseProps}>{text}</p>
  }

  return getElement()
})
