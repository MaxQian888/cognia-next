"use client"

import { memo } from "react"
import { cn } from "@/lib/utils"
import { Kbd } from "@/components/ui/kbd"

interface KbdInlineProps {
  children: React.ReactNode
  className?: string
  variant?: "default" | "outline" | "ghost"
}

export const KbdInline = memo(function KbdInline({
  children,
  className,
  variant = "default",
}: KbdInlineProps) {
  const variantClasses = {
    default: "border border-border shadow-sm shadow-muted-foreground/20",
    outline: "border border-border bg-transparent",
    ghost: "bg-muted/50 border-transparent",
  }

  return <Kbd className={cn(variantClasses[variant], className)}>{children}</Kbd>
})

export default KbdInline
