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
  // Semantic tokens (ADR-0218), so alerts follow dark mode and custom themes
  // instead of fixed Tailwind hues. `important` takes the theme primary: a
  // neutral theme draws it as plain emphasis, a coloured theme in its accent.
  note: {
    icon: Info,
    className: "border-info/60 bg-info/8",
    iconClassName: "text-info",
  },
  tip: {
    icon: Lightbulb,
    className: "border-success/60 bg-success/8",
    iconClassName: "text-success",
  },
  important: {
    icon: AlertCircle,
    className: "border-primary/50 bg-primary/5",
    iconClassName: "text-primary",
  },
  warning: {
    icon: AlertTriangle,
    className: "border-warning/70 bg-warning/10",
    iconClassName: "text-warning",
  },
  caution: {
    icon: Flame,
    className: "border-destructive/60 bg-destructive/8",
    iconClassName: "text-destructive",
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
        // Compact, and on the shared block rhythm (ADR-0218). Sizes are `em`,
        // so the alert follows the chat text-size setting.
        "my-(--rich-block-gap) rounded-md border-l-[3px] px-3 py-2.5 transition-all duration-200",
        config.className,
        collapsible &&
          "cursor-pointer hover:brightness-95 dark:hover:brightness-110 hover:shadow-sm",
        className
      )}
    >
      <div className="flex items-start gap-2.5">
        <Icon className={cn("mt-[0.2em] size-[1.1em] shrink-0", config.iconClassName)} />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className={cn("text-[0.9em] font-semibold", config.iconClassName)}>
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
            <CollapsibleContent className="mt-1 transition-all duration-300 ease-out [&>:first-child]:mt-0">
              {children}
            </CollapsibleContent>
          ) : (
            <div className="mt-1 [&>:first-child]:mt-0">{children}</div>
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
