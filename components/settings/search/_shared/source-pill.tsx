"use client"

import { Check } from "lucide-react"
import { cn } from "@/lib/utils"

export interface SourcePillProps {
  sourceId: string
  name: string
  icon?: string
  selected: boolean
  disabled: boolean
  onToggle: () => void
  onRemove?: () => void
}

export function SourcePill({
  name,
  icon,
  selected,
  disabled,
  onToggle,
  onRemove,
}: SourcePillProps) {
  return (
    <button
      type="button"
      onClick={onToggle}
      disabled={disabled}
      className={cn(
        "inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition-colors",
        selected
          ? "bg-primary text-primary-foreground"
          : "bg-muted text-muted-foreground hover:bg-muted/80",
        disabled && "opacity-50 cursor-not-allowed",
        !disabled && "cursor-pointer"
      )}
    >
      <span>{icon || "🔗"}</span>
      <span>{name}</span>
      {selected && <Check className="h-3 w-3" />}
      {onRemove && (
        <span
          role="button"
          tabIndex={-1}
          className="ml-1 hover:text-destructive cursor-pointer"
          onClick={(e) => {
            e.stopPropagation()
            onRemove()
          }}
        >
          ×
        </span>
      )}
    </button>
  )
}
