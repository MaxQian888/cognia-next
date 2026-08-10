"use client"

/**
 * Canonical row primitive for the mobile profile screen.
 *
 * One component covers the three shapes we need:
 *   • Navigational row     — `href` set, renders an `<a>` with chevron.
 *   • Action row           — `onClick` set, renders a `<button>` with chevron.
 *   • Value-only row       — neither set, renders a `<div>` for status display.
 *
 * All variants use the same `Item` + `ItemMedia` + `ItemContent` + `ItemActions`
 * layout from `components/ui/item.tsx`, so the visual rhythm matches the
 * connection-state sheets and discover cards.
 */

import * as React from "react"
import Link from "next/link"
import { ChevronRightIcon, type LucideIcon } from "lucide-react"

import {
  MobileSpotIcon,
  type MobileSpotIconName,
} from "@/components/mobile/mobile-spot-icon"
import { cn } from "@/lib/utils"
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from "@/components/ui/item"
import { Button } from "@/components/ui/button"

export interface MeRowProps {
  /** Lucide icon component rendered in the leading slot. Optional. */
  icon?: LucideIcon
  /** Larger companion illustration for a selected feature entry. */
  spotIcon?: MobileSpotIconName
  /** Tint class applied to the icon wrapper (e.g. `text-emerald-600`). */
  iconClassName?: string
  /** Primary label. */
  label: string
  /** Secondary description rendered under the label. Optional. */
  description?: React.ReactNode
  /** Right-side value or status badge rendered inside `ItemActions`. */
  value?: React.ReactNode
  /** When set, the row becomes an `<a href>` and a chevron is appended. */
  href?: string
  /** When set (and `href` is absent), the row becomes a `<button>`. */
  onClick?: () => void
  /** Tints the label red — use for destructive actions like 退出登录. */
  destructive?: boolean
  /** Disables the interactive variants. */
  disabled?: boolean
  /** ARIA label for icon-only triggers; defaults to `label`. */
  ariaLabel?: string
  className?: string
  testid?: string
}

export function MeRow({
  icon: Icon,
  spotIcon,
  iconClassName,
  label,
  description,
  value,
  href,
  onClick,
  destructive,
  disabled,
  ariaLabel,
  className,
  testid,
}: MeRowProps) {
  const interactive = Boolean(href || onClick) && !disabled
  const hasChevron = interactive
  const labelClass = cn(
    "text-sm font-medium",
    destructive && "text-destructive",
    disabled && "text-muted-foreground"
  )
  const baseClass = cn(
    "px-3 py-2.5",
    interactive && "active:bg-muted/50 transition-colors",
    className
  )

  const inner = (
    <>
      {spotIcon ? (
        <ItemMedia className={cn("size-12", iconClassName)}>
          <MobileSpotIcon name={spotIcon} size={48} />
        </ItemMedia>
      ) : Icon ? (
        <ItemMedia variant="icon" className={cn("size-9 rounded-md", iconClassName)}>
          <Icon className="size-4" aria-hidden="true" />
        </ItemMedia>
      ) : null}
      <ItemContent>
        <ItemTitle className={labelClass}>{label}</ItemTitle>
        {description ? <ItemDescription className="text-xs">{description}</ItemDescription> : null}
      </ItemContent>
      {value || hasChevron ? (
        <ItemActions>
          {value ? <span className="text-xs text-muted-foreground">{value}</span> : null}
          {hasChevron ? (
            <ChevronRightIcon className="size-4 text-muted-foreground" aria-hidden="true" />
          ) : null}
        </ItemActions>
      ) : null}
    </>
  )

  if (href && !disabled) {
    return (
      <Item
        asChild
        size="sm"
        className={baseClass}
        data-testid={testid}
        aria-label={ariaLabel ?? label}
      >
        <Link href={href}>{inner}</Link>
      </Item>
    )
  }

  if (onClick && !disabled) {
    return (
      <Item asChild size="sm" className={baseClass} data-testid={testid}>
        <Button
          variant="ghost"
          onClick={onClick}
          aria-label={ariaLabel ?? label}
          className="h-auto w-full justify-start rounded-none p-0 text-left font-normal"
        >
          {inner}
        </Button>
      </Item>
    )
  }

  return (
    <Item
      size="sm"
      className={baseClass}
      data-testid={testid}
      aria-disabled={disabled ? true : undefined}
    >
      {inner}
    </Item>
  )
}
