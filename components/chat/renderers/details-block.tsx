"use client"

import { memo, useState } from "react"
import { ChevronRight } from "lucide-react"
import { cn } from "@/lib/utils"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"

interface DetailsBlockProps {
  summary: React.ReactNode
  children: React.ReactNode
  className?: string
  defaultOpen?: boolean
  variant?: "default" | "bordered" | "filled"
}

export const DetailsBlock = memo(function DetailsBlock({
  summary,
  children,
  className,
  defaultOpen = false,
  variant = "default",
}: DetailsBlockProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen)

  const variantClasses = {
    default: "",
    bordered: "border rounded-lg",
    filled: "border rounded-lg bg-muted/30",
  }

  return (
    <Collapsible
      open={isOpen}
      onOpenChange={setIsOpen}
      className={cn("my-3", variantClasses[variant], className)}
    >
      <CollapsibleTrigger
        className={cn(
          "flex w-full items-center gap-2 text-left font-medium text-sm hover:text-primary transition-colors",
          "group cursor-pointer select-none",
          variant !== "default" && "p-3"
        )}
      >
        <ChevronRight
          className={cn(
            "h-4 w-4 shrink-0 transition-transform duration-200",
            isOpen && "rotate-90"
          )}
        />
        <span className="flex-1">{summary}</span>
      </CollapsibleTrigger>
      <CollapsibleContent
        className={cn(
          "overflow-hidden transition-all data-[state=closed]:animate-accordion-up data-[state=open]:animate-accordion-down",
          variant !== "default" ? "px-3 pb-3 pt-0" : "pl-6 pt-2"
        )}
      >
        <div className="text-sm text-muted-foreground">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  )
})

interface DetailsGroupProps {
  children: React.ReactNode
  className?: string
  allowMultiple?: boolean
}

export const DetailsGroup = memo(function DetailsGroup({
  children,
  className,
  allowMultiple = true,
}: DetailsGroupProps) {
  return (
    <div
      className={cn(
        "space-y-2 my-4",
        !allowMultiple && "[&>*]:data-[state=open]:border-primary/50",
        className
      )}
      data-allow-multiple={allowMultiple}
    >
      {children}
    </div>
  )
})

export default DetailsBlock
