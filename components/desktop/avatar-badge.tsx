"use client"

import { avatarColor, avatarGlyph, type AvatarSubject } from "@/lib/ui/avatar"
import { cn } from "@/lib/utils"
import { useState, type CSSProperties, type ReactNode } from "react"

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
  // Fall back to the glyph if the image fails to load (stale tauriPath, etc.).
  const [imgFailed, setImgFailed] = useState(false)
  const showImage = Boolean(subject.avatarImageUrl) && !imgFailed
  const style: CSSProperties = {
    width: size,
    height: size,
    backgroundColor: avatarColor(subject),
    color: "white",
  }
  return (
    <span
      className={cn(
        "relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full",
        textClassName,
        className
      )}
      style={style}
      aria-hidden
    >
      {showImage ? (
        // eslint-disable-next-line @next/next/no-img-element -- avatar is a data:/asset URL, not an optimizable remote asset
        <img
          src={subject.avatarImageUrl}
          alt=""
          className="size-full object-cover"
          onError={() => setImgFailed(true)}
        />
      ) : (
        avatarGlyph(subject)
      )}
      {statusDot}
    </span>
  )
}
