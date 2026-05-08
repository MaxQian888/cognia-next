"use client"

import Link from "next/link"
import { useTranslations } from "next-intl"

import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import type { Character } from "@/lib/claude/types"
import { cn } from "@/lib/utils"

export interface CharacterCardProps {
  character: Character
  href?: string
  onSelect?: (character: Character) => void
  className?: string
}

/**
 * Compact character row for the Discover tab. Tap → opens chat picker;
 * long-press surfaces context actions (handled by the parent screen via
 * `<LongPress />`).
 */
export function CharacterCard({ character, href, onSelect, className }: CharacterCardProps) {
  const t = useTranslations("mobile.discover")
  const initials = character.name.slice(0, 2).toUpperCase()
  const inner = (
    <div
      className={cn(
        "flex items-center gap-3 rounded-md border border-border bg-card p-3",
        "active:bg-muted/50 transition-colors",
        className
      )}
      data-testid={`character-card-${character.id}`}
    >
      <Avatar className="size-12">
        <AvatarFallback
          style={{ backgroundColor: character.avatarColor }}
          className="text-base"
          aria-hidden={character.avatarEmoji ? "true" : undefined}
        >
          {character.avatarEmoji ?? initials}
        </AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <h3 className="truncate text-sm font-semibold">{character.name}</h3>
          {character.isBuiltIn ? (
            <Badge variant="outline" className="text-[10px]">
              {t("builtInBadge")}
            </Badge>
          ) : null}
        </div>
        {character.description ? (
          <p className="line-clamp-1 text-xs text-muted-foreground">{character.description}</p>
        ) : null}
      </div>
    </div>
  )
  if (href) {
    return (
      <Link href={href} className="block">
        {inner}
      </Link>
    )
  }
  if (onSelect) {
    return (
      <button type="button" onClick={() => onSelect(character)} className="block w-full text-left">
        {inner}
      </button>
    )
  }
  return inner
}
