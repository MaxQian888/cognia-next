"use client"

import { useTranslations } from "next-intl"
import { motion, useReducedMotion } from "motion/react"

import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { avatarColor, avatarGlyph } from "@/lib/ui/avatar"
import { STAGGER_CHILD, STAGGER_CONTAINER } from "@/lib/ui/motion"
import type { Character } from "@/lib/claude/types"
import { cn } from "@/lib/utils"

export interface FeaturedCarouselProps {
  characters: Character[]
  /** Tapping a tile emits its character. */
  onSelect: (character: Character) => void
  className?: string
}

/**
 * Horizontally scrolling row of tiles for "featured" characters (built-in
 * personas the user can start a chat with in one tap). Hidden when fewer
 * than 3 characters are eligible, since one tile doesn't read as a row.
 */
export function FeaturedCarousel({ characters, onSelect, className }: FeaturedCarouselProps) {
  const t = useTranslations("mobile.discover")
  const reduce = useReducedMotion()
  if (characters.length < 3) return null
  return (
    <section className={cn("flex flex-col gap-2", className)} data-testid="featured-carousel">
      <header className="flex items-baseline justify-between px-4">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t("featured")}
        </h2>
      </header>
      <motion.ul
        className="flex snap-x snap-mandatory gap-3 overflow-x-auto px-4 pb-2"
        role="list"
        data-testid="featured-carousel-list"
        initial={reduce ? false : "initial"}
        animate="animate"
        variants={STAGGER_CONTAINER}
      >
        {characters.map((c) => (
          <motion.li key={c.id} className="snap-start" variants={STAGGER_CHILD}>
            <Button
              type="button"
              variant="ghost"
              onClick={() => onSelect(c)}
              data-testid={`featured-tile-${c.id}`}
              className="h-auto w-24 flex-col items-center gap-1.5 rounded-md border border-border bg-card p-3 text-left font-normal"
            >
              <Avatar className="size-12">
                <AvatarFallback
                  style={{ backgroundColor: avatarColor(c) }}
                  className="text-base"
                  aria-hidden={c.avatarEmoji ? "true" : undefined}
                >
                  {avatarGlyph(c)}
                </AvatarFallback>
              </Avatar>
              <span className="line-clamp-2 text-center text-[11px] font-medium leading-tight">
                {c.name}
              </span>
            </Button>
          </motion.li>
        ))}
      </motion.ul>
    </section>
  )
}
