"use client"

import { memo, useState } from "react"
import {
  Info,
  Lightbulb,
  AlertTriangle,
  AlertCircle,
  Flame,
  ChevronDown,
  type LucideIcon,
} from "lucide-react"
import { cn } from "@/lib/utils"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"

export type AlertType = "note" | "tip" | "important" | "warning" | "caution"

interface AlertBlockProps {
  type: AlertType
  title?: string
  children: React.ReactNode
  className?: string
  collapsible?: boolean
  defaultOpen?: boolean
}

const alertConfig: Record<
  AlertType,
  {
    icon: LucideIcon
    title: string
    className: string
    iconClassName: string
  }
> = {
  note: {
    icon: Info,
    title: "Note",
    className: "border-blue-500/50 bg-blue-500/10",
    iconClassName: "text-blue-500",
  },
  tip: {
    icon: Lightbulb,
    title: "Tip",
    className: "border-green-500/50 bg-green-500/10",
    iconClassName: "text-green-500",
  },
  important: {
    icon: AlertCircle,
    title: "Important",
    className: "border-purple-500/50 bg-purple-500/10",
    iconClassName: "text-purple-500",
  },
  warning: {
    icon: AlertTriangle,
    title: "Warning",
    className: "border-yellow-500/50 bg-yellow-500/10",
    iconClassName: "text-yellow-500",
  },
  caution: {
    icon: Flame,
    title: "Caution",
    className: "border-red-500/50 bg-red-500/10",
    iconClassName: "text-red-500",
  },
}

export const AlertBlock = memo(function AlertBlock({
  type,
  title,
  children,
  className,
  collapsible = false,
  defaultOpen = true,
}: AlertBlockProps) {
  const [isOpen, setIsOpen] = useState(defaultOpen)
  const config = alertConfig[type]
  const Icon = config.icon
  const displayTitle = title || config.title

  const content = (
    <div
      className={cn(
        "rounded-lg border-l-4 p-4 my-4 transition-all duration-200",
        config.className,
        collapsible &&
          "cursor-pointer hover:brightness-95 dark:hover:brightness-110 hover:shadow-sm",
        className
      )}
    >
      <div className="flex items-start gap-3">
        <Icon className={cn("h-5 w-5 mt-0.5 shrink-0", config.iconClassName)} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className={cn("font-semibold text-sm", config.iconClassName)}>
              {displayTitle}
            </span>
            {collapsible && (
              <ChevronDown
                className={cn(
                  "h-4 w-4 transition-transform duration-300 ease-out",
                  config.iconClassName,
                  !isOpen && "-rotate-90"
                )}
              />
            )}
          </div>
          {collapsible ? (
            <CollapsibleContent className="mt-2 text-sm transition-all duration-300 ease-out">
              {children}
            </CollapsibleContent>
          ) : (
            <div className="mt-2 text-sm">{children}</div>
          )}
        </div>
      </div>
    </div>
  )

  if (collapsible) {
    return (
      <Collapsible open={isOpen} onOpenChange={setIsOpen}>
        <CollapsibleTrigger asChild>{content}</CollapsibleTrigger>
      </Collapsible>
    )
  }

  return content
})

/**
 * Parse GitHub-style alert syntax from blockquote content.
 * Supports: > [!NOTE], > [!TIP], > [!IMPORTANT], > [!WARNING], > [!CAUTION]
 */
export function parseAlertFromBlockquote(content: string): {
  type: AlertType
  content: string
} | null {
  const alertPattern = /^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*\n?/i
  const match = content.match(alertPattern)

  if (match) {
    const type = match[1].toLowerCase() as AlertType
    const cleanContent = content.replace(alertPattern, "").trim()
    return { type, content: cleanContent }
  }

  return null
}

export default AlertBlock
