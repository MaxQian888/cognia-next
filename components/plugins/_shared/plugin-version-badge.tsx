"use client"

/**
 * Tiny version-badge shared by every place that renders `v{version}`
 * — marketplace card, detail Sheet header, library row, discovery
 * hero strip. The four call sites previously varied between Badge
 * variant="secondary" and a bare `<span class="text-muted-foreground">`.
 */

import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"

interface Props {
  version: string
  className?: string
  variant?: "secondary" | "outline" | "default"
}

export function PluginVersionBadge({ version, className, variant = "secondary" }: Props) {
  return (
    <Badge
      variant={variant}
      className={cn("text-xs font-normal tabular-nums", className)}
      data-testid="plugin-version-badge"
    >
      v{version}
    </Badge>
  )
}
