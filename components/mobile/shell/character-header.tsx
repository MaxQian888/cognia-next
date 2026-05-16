"use client"

import { useTranslations } from "next-intl"

import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { avatarColor, avatarGlyph, type AvatarSubject } from "@/lib/ui/avatar"
import { cn } from "@/lib/utils"

export interface CharacterHeaderProps {
  /** Active session's character / team. When null, fallback title is shown. */
  subject?: AvatarSubject | null
  /** Title rendered when no subject is available (e.g. "cognia"). */
  fallbackTitle: string
  /** Show a small streaming dot under the name. */
  streaming?: boolean
  className?: string
}

/**
 * Mobile chat shell header: small avatar + name + (optional) streaming dot.
 * Drops in where the bare `<h1>` used to live; designed to compose with
 * external left-trigger and right-action buttons supplied by the parent.
 */
export function CharacterHeader({
  subject,
  fallbackTitle,
  streaming = false,
  className,
}: CharacterHeaderProps) {
  const t = useTranslations("mobile.home")
  if (!subject) {
    return (
      <h1
        className={cn("min-w-0 truncate text-sm font-medium sm:text-base", className)}
        data-testid="mobile-active-title"
      >
        {fallbackTitle}
      </h1>
    )
  }
  return (
    <div
      className={cn("flex min-w-0 flex-1 items-center gap-2", className)}
      data-testid="character-header"
    >
      <Avatar className="size-8 shrink-0">
        <AvatarFallback
          style={{ backgroundColor: avatarColor(subject) }}
          className="text-xs"
          aria-hidden={subject.avatarEmoji ? "true" : undefined}
        >
          {avatarGlyph(subject)}
        </AvatarFallback>
      </Avatar>
      <div className="flex min-w-0 flex-col leading-tight">
        <span
          className="truncate text-sm font-medium sm:text-base"
          data-testid="mobile-active-title"
        >
          {subject.name}
        </span>
        {streaming ? (
          <Badge
            variant="outline"
            data-testid="character-header-streaming"
            className="h-4 w-fit gap-1 border-primary/30 bg-primary/5 px-1.5 py-0 text-[10px] font-normal text-primary"
          >
            <span
              aria-hidden="true"
              className="size-1.5 rounded-full bg-primary motion-safe:animate-pulse"
            />
            {t("presenceStreaming")}
          </Badge>
        ) : null}
      </div>
    </div>
  )
}
