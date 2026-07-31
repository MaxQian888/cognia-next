"use client"

/**
 * One row inside the Inbox notice area.
 *
 * Replaces four bespoke palettes that each painted a full-bleed coloured band
 * across the detail pane (`border-amber-200/60 bg-amber-50/60 …`,
 * `border-rose-200/60 bg-rose-50/60 …`, `bg-amber-50 …`,
 * `border-amber-500/30 bg-amber-500/10`). With up to five of them stacked, the
 * conversation opened behind a wall of colour.
 *
 * The replacement carries severity on a 2px left rail plus the icon — a tone
 * difference OR a border, never both — and never on colour alone: each row
 * also states its severity to assistive tech.
 */

import type { ReactNode } from "react"
import { useTranslations } from "next-intl"
import { AlertOctagonIcon, AlertTriangleIcon, InfoIcon, XIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

export type NoticeSeverity = "info" | "warning" | "danger"

/** Rail + icon tint per severity. Body text stays `foreground` at every level. */
const SEVERITY_STYLE: Record<NoticeSeverity, { rail: string; icon: string }> = {
  info: { rail: "before:bg-info/60", icon: "text-info" },
  warning: { rail: "before:bg-warning/70", icon: "text-warning" },
  danger: { rail: "before:bg-destructive/70", icon: "text-destructive" },
}

const SEVERITY_ICON: Record<NoticeSeverity, typeof InfoIcon> = {
  info: InfoIcon,
  warning: AlertTriangleIcon,
  danger: AlertOctagonIcon,
}

interface NoticeItemBaseProps {
  severity: NoticeSeverity
  /** Overrides the per-severity default icon. */
  icon?: ReactNode
  /** One-line headline — the only part shown in a collapsed summary. */
  title: ReactNode
  /** Detail body. Callers render it only when the area is expanded. */
  children?: ReactNode
  /** Trailing controls (Reconnect / Review / View outbound …). */
  actions?: ReactNode
  className?: string
  "data-testid"?: string
}

/**
 * A dismiss control always needs a name. Expressed as a union rather than an
 * optional pair so the compiler enforces it — as two optional props it was
 * possible to ship a button whose only accessible name was `undefined`.
 */
type NoticeItemDismissProps =
  | {
      onDismiss: () => void
      /** Accessible label for the dismiss control. */
      dismissLabel: string
      /** Test id for the dismiss control, so sources keep their existing hooks. */
      dismissTestId?: string
    }
  | { onDismiss?: never; dismissLabel?: never; dismissTestId?: never }

export type NoticeItemProps = NoticeItemBaseProps & NoticeItemDismissProps

export function NoticeItem({
  severity,
  icon,
  title,
  children,
  actions,
  onDismiss,
  dismissLabel,
  dismissTestId,
  className,
  "data-testid": testId,
}: NoticeItemProps) {
  const t = useTranslations("inbox.notices")
  const style = SEVERITY_STYLE[severity]
  const Icon = SEVERITY_ICON[severity]

  return (
    <div
      // Only a problem interrupts. `alert` is assertive, and with up to five
      // rows opening at once a blanket `alert` made a screen reader announce
      // the activity log over whatever the user was doing. Info rows are
      // ambient, so they go out politely.
      role={severity === "info" ? "status" : "alert"}
      data-severity={severity}
      data-testid={testId}
      className={cn(
        "relative flex items-start gap-2 py-1.5 pe-2 ps-3 text-xs text-foreground",
        "before:absolute before:inset-y-1 before:start-0 before:w-0.5 before:rounded-full",
        style.rail,
        className
      )}
    >
      {/* Severity must not be carried by colour alone. */}
      <span className="sr-only">{t(`severity.${severity}`)}</span>
      {icon ?? <Icon className={cn("mt-0.5 size-3.5 shrink-0", style.icon)} aria-hidden />}
      <div className="min-w-0 flex-1">
        <p className="font-medium">{title}</p>
        {children}
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
      {onDismiss ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="size-6 shrink-0"
          onClick={onDismiss}
          aria-label={dismissLabel}
          data-testid={dismissTestId}
        >
          <XIcon className="size-3" aria-hidden />
        </Button>
      ) : null}
    </div>
  )
}
