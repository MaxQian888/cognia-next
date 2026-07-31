"use client"

import { useTranslations } from "next-intl"
import { AnimatePresence, motion, useReducedMotion } from "motion/react"

import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { avatarColor, avatarGlyph, type AvatarSubject } from "@/lib/ui/avatar"
import { MOBILE_DURATION, MOBILE_EASE } from "@/lib/ui/motion"
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
  const reduce = useReducedMotion()
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
      <span className="relative shrink-0">
        <Avatar className="size-8">
          <AvatarFallback
            style={{ backgroundColor: avatarColor(subject) }}
            className="text-xs"
            aria-hidden={subject.avatarEmoji ? "true" : undefined}
          >
            {avatarGlyph(subject)}
          </AvatarFallback>
        </Avatar>
        {/* A halo on the avatar, not just a badge under the name: while a turn
            streams the header is often the only chrome on screen that isn't
            scrolled away, and the avatar is the part the eye already rests on. */}
        {streaming ? (
          <motion.span
            aria-hidden="true"
            data-testid="character-header-streaming-ring"
            className="absolute inset-0 rounded-full ring-2 ring-primary/50"
            initial={reduce ? false : { opacity: 0.25, scale: 1 }}
            animate={reduce ? { opacity: 0.6 } : { opacity: [0.25, 0.7, 0.25], scale: [1, 1.12, 1] }}
            transition={
              reduce ? { duration: 0 } : { duration: 1.8, repeat: Infinity, ease: "easeInOut" }
            }
          />
        ) : null}
      </span>
      <div className="flex min-w-0 flex-col leading-tight">
        <span
          className="truncate text-sm font-medium sm:text-base"
          data-testid="mobile-active-title"
        >
          {subject.name}
        </span>
        {/* Animate the height too. A bare mount/unmount shoved the name up and
            down by a full badge row every time a turn started or settled. */}
        <AnimatePresence initial={false}>
          {streaming ? (
            <motion.span
              key="streaming"
              className="block overflow-hidden"
              initial={reduce ? false : { height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={reduce ? { opacity: 0 } : { height: 0, opacity: 0 }}
              transition={{ duration: MOBILE_DURATION.fast, ease: MOBILE_EASE }}
            >
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
            </motion.span>
          ) : null}
        </AnimatePresence>
      </div>
    </div>
  )
}
