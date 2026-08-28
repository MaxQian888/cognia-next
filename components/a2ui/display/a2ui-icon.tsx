"use client"

/**
 * A2UI Icon Component
 * Renders Lucide icons by name
 */

import React, { memo } from "react"
import { cn } from "@/lib/utils"
import { HelpCircle } from "lucide-react"
import { getLucideIcon } from "@/lib/icons/lucide-catalog"
import type { A2UIComponentProps, A2UIIconComponent } from "@/types/a2ui/schema"

export const A2UIIcon = memo(function A2UIIcon({
  component,
}: A2UIComponentProps<A2UIIconComponent>) {
  const iconName = component.name
  const size = component.size || 24
  const color = component.color

  // Convert icon name to PascalCase for Lucide
  const formatIconName = (name: string): string => {
    return name
      .split(/[-_\s]/)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
      .join("")
  }

  const pascalName = formatIconName(iconName)
  const IconComponent = getLucideIcon(iconName) ?? getLucideIcon(pascalName)

  if (!IconComponent) {
    // Fallback to a default icon
    const FallbackIcon = HelpCircle
    return (
      <span
        className={cn("inline-flex", component.className)}
        style={component.style as React.CSSProperties}
      >
        <FallbackIcon size={size} color={color} />
      </span>
    )
  }

  return (
    <span
      className={cn("inline-flex", component.className)}
      style={component.style as React.CSSProperties}
    >
      <IconComponent size={size} color={color} />
    </span>
  )
})
