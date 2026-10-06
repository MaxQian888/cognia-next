"use client"

import { Children, cloneElement, isValidElement, memo, useState } from "react"
import { useTranslations } from "next-intl"
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
    className: string
    iconClassName: string
  }
> = {
  note: {
    icon: Info,
    className: "border-blue-500/50 bg-blue-500/10",
    iconClassName: "text-blue-500",
  },
  tip: {
    icon: Lightbulb,
    className: "border-green-500/50 bg-green-500/10",
    iconClassName: "text-green-500",
  },
  important: {
    icon: AlertCircle,
    className: "border-purple-500/50 bg-purple-500/10",
    iconClassName: "text-purple-500",
  },
  warning: {
    icon: AlertTriangle,
    className: "border-yellow-500/50 bg-yellow-500/10",
    iconClassName: "text-yellow-500",
  },
  caution: {
    icon: Flame,
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
  const t = useTranslations("chat.renderers.alert")
  const [isOpen, setIsOpen] = useState(defaultOpen)
  const config = alertConfig[type]
  const Icon = config.icon
  const displayTitle = title || t(type)

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

const ALERT_MARKER = /^\s*\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/i

function isBlankText(node: React.ReactNode): boolean {
  return typeof node === "string" && node.trim() === ""
}

/**
 * Remove the leading `[!TYPE]` marker from the first text leaf of `node`,
 * keeping every element around it. Returns null when the first text leaf
 * does not start with a marker. A container emptied by the strip (the
 * `> [!NOTE]` line written as its own paragraph) is dropped.
 */
function stripLeadingMarker(
  node: React.ReactNode
): { type: AlertType; node: React.ReactNode } | null {
  if (typeof node === "string") {
    const match = node.match(ALERT_MARKER)
    if (!match) return null
    const rest = node.slice(match[0].length)
    return { type: match[1].toLowerCase() as AlertType, node: rest === "" ? null : rest }
  }
  if (!isValidElement(node)) return null
  const props = node.props as { children?: React.ReactNode }
  const kids = Children.toArray(props.children)
  const first = kids.findIndex((kid) => !isBlankText(kid))
  if (first === -1) return null
  const stripped = stripLeadingMarker(kids[first])
  if (!stripped) return null
  const nextKids = [...kids.slice(0, first), stripped.node, ...kids.slice(first + 1)].filter(
    (kid) => kid !== null
  )
  if (nextKids.every(isBlankText)) return { type: stripped.type, node: null }
  return { type: stripped.type, node: cloneElement(node, undefined, ...nextKids) }
}

/**
 * Detect a GitHub-style alert (`> [!NOTE]`, `[!TIP]`, `[!IMPORTANT]`,
 * `[!WARNING]`, `[!CAUTION]`) in rendered blockquote children. It works on the
 * element tree rather than a flattened string, so bold, links, inline code,
 * lists and line breaks inside an alert survive.
 */
export function extractAlertFromChildren(
  children: React.ReactNode
): { type: AlertType; children: React.ReactNode[] } | null {
  const kids = Children.toArray(children)
  const first = kids.findIndex((kid) => !isBlankText(kid))
  if (first === -1) return null
  const stripped = stripLeadingMarker(kids[first])
  if (!stripped) return null
  const rest = [...kids.slice(0, first), stripped.node, ...kids.slice(first + 1)].filter(
    (kid) => kid !== null && !isBlankText(kid)
  )
  return { type: stripped.type, children: rest }
}

export default AlertBlock
