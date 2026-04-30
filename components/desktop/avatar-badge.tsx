"use client"

import { avatarColor, avatarGlyph, type AvatarSubject } from "@/lib/ui/avatar"
import { cn } from "@/lib/utils"
import type { CSSProperties, ReactNode } from "react"

interface AvatarBadgeProps {
  /** Anything with `name` (and optionally `avatarColor` / `avatarEmoji`). */
  subject: AvatarSubject
  /** Pixel diameter of the badge. Defaults to 16 (matches the smallest legacy use). */
  size?: number
  /** Tailwind text-size class for the glyph. Defaults to `text-[10px]`. */
  textClassName?: string
  /** Extra classes merged onto the root span. */
  className?: string
  /** Live status dot rendered in the bottom-right corner (used by member-list). */
  statusDot?: ReactNode
}

/**
 * Shared avatar primitive used by guild-rail, channel-list, command-palette,
 * member-list, and onboarding-dialog. Renders a colored circle containing
 * the subject's emoji or initials.
 */
export function AvatarBadge({
  subject,
  size = 16,
  textClassName = "text-[10px]",
  className,
  statusDot,
}: AvatarBadgeProps) {
  const style: CSSProperties = {
    width: size,
    height: size,
    backgroundColor: avatarColor(subject),
    color: "white",
  }
  return (
    <span
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center rounded-full",
        textClassName,
        className
      )}
      style={style}
      aria-hidden
    >
      {avatarGlyph(subject)}
      {statusDot}
    </span>
  )
}
