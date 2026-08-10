"use client"

import { Check, X } from "lucide-react"
import { Button } from "@/components/ui/button"
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
    <div
      className={cn(
        "inline-flex items-center rounded-full text-xs font-medium transition-colors",
        selected
          ? "bg-primary text-primary-foreground"
          : "bg-muted text-muted-foreground hover:bg-muted/80",
        disabled && "opacity-50"
      )}
    >
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={onToggle}
        disabled={disabled}
        className="h-auto rounded-full px-3 py-1.5 text-inherit hover:bg-transparent hover:text-inherit"
      >
        <span>{icon || "🔗"}</span>
        <span>{name}</span>
        {selected && <Check className="size-3" />}
      </Button>
      {onRemove && (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          className="mr-1 rounded-full text-inherit hover:bg-background/20 hover:text-destructive"
          onClick={onRemove}
          aria-label={`× ${name}`}
        >
          <X className="size-3" aria-hidden />
        </Button>
      )}
    </div>
  )
}
