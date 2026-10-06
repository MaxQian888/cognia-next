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
      className={cn("my-(--rich-block-gap)", variantClasses[variant], className)}
    >
      <CollapsibleTrigger
        className={cn(
          "flex w-full items-center gap-2 text-left font-medium text-[0.95em] hover:text-primary transition-colors",
          "group cursor-pointer select-none",
          variant !== "default" && "p-3"
        )}
      >
        <ChevronRight
          className={cn(
            "size-[1.1em] shrink-0 transition-transform duration-200",
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
        <div className="text-[0.95em] text-muted-foreground [&>:first-child]:mt-0">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  )
})

export default DetailsBlock
