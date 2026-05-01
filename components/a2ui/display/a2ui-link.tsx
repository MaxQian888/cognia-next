"use client"

/**
 * A2UI Link Component
 * Renders a clickable link
 */

import React, { memo } from "react"
import { cn } from "@/lib/utils"
import { ExternalLink } from "lucide-react"
import type { A2UIComponentProps, A2UILinkComponent } from "@/types/a2ui/schema"
import { useA2UIData } from "../a2ui-context"

export const A2UILink = memo(function A2UILink({
  component,
  onAction,
}: A2UIComponentProps<A2UILinkComponent>) {
  const { resolveString } = useA2UIData()

  const text = resolveString(component.text, "")
  const href = component.href
  const external = component.external ?? (href?.startsWith("http") || false)

  const handleClick = (e: React.MouseEvent) => {
    if (component.action) {
      e.preventDefault()
      onAction(component.action, { href })
    }
  }

  const linkProps = external ? { target: "_blank", rel: "noopener noreferrer" } : {}

  if (component.action && !href) {
    return (
      <button
        type="button"
        className={cn(
          "inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          component.disabled && "opacity-50 cursor-not-allowed",
          component.className
        )}
        style={component.style as React.CSSProperties}
        onClick={handleClick}
        disabled={component.disabled as boolean}
      >
        {text}
        {external && <ExternalLink className="h-3 w-3" />}
      </button>
    )
  }

  return (
    <a
      href={href || "#"}
      className={cn(
        "inline-flex items-center gap-1 text-primary underline-offset-4 hover:underline",
        component.disabled && "opacity-50 pointer-events-none",
        component.className
      )}
      style={component.style as React.CSSProperties}
      onClick={component.action ? handleClick : undefined}
      {...linkProps}
    >
      {text}
      {external && <ExternalLink className="h-3 w-3" />}
    </a>
  )
})
