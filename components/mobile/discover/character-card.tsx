"use client"

import Link from "next/link"
import { useTranslations } from "next-intl"

import { Avatar, AvatarFallback } from "@/components/ui/avatar"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Item, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@/components/ui/item"
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
 * `<LongPress />`). Renders as a shadcn Item so the row picks up the
 * consistent focus-visible + outline treatment shared with the rest of
 * the discover surface.
 */
export function CharacterCard({ character, href, onSelect, className }: CharacterCardProps) {
  const t = useTranslations("discover")
  const initials = character.name.slice(0, 2).toUpperCase()
  const item = (
    <Item
      variant="outline"
      size="sm"
      className={cn(
        "bg-card transition-colors active:bg-muted/50",
        // Item carries `flex-wrap` for very narrow widths; the avatar +
        // text composition should stay on a single row in the discover
        // grid, so we hard-set flex-nowrap.
        "flex-nowrap",
        className
      )}
      data-testid={`character-card-${character.id}`}
    >
      <ItemMedia variant="image" className="size-12">
        <Avatar className="size-12">
          <AvatarFallback
            style={{ backgroundColor: character.avatarColor }}
            className="text-base"
            aria-hidden={character.avatarEmoji ? "true" : undefined}
          >
            {character.avatarEmoji ?? initials}
          </AvatarFallback>
        </Avatar>
      </ItemMedia>
      <ItemContent>
        <ItemTitle className="flex items-center gap-2 text-sm">
          <span className="truncate">{character.name}</span>
          {character.isBuiltIn ? (
            <Badge variant="outline" className="text-[10px]">
              {t("builtInBadge")}
            </Badge>
          ) : null}
          {/* ADR-0030 — plugin-overlay or cloned-from-plugin attribution
              surfaces a single "Plugin" pill on mobile so the user can
              tell at a glance whether a row came from a plugin pack. */}
          {character.sourcePluginId ? (
            <Badge variant="outline" className="text-[10px]">
              {t("pluginBadge")}
            </Badge>
          ) : null}
        </ItemTitle>
        {character.description ? (
          <ItemDescription className="line-clamp-1 text-xs">
            {character.description}
          </ItemDescription>
        ) : null}
      </ItemContent>
    </Item>
  )
  if (href) {
    return (
      <Link href={href} className="block">
        {item}
      </Link>
    )
  }
  if (onSelect) {
    return (
      <Button
        type="button"
        variant="ghost"
        onClick={() => onSelect(character)}
        className="block h-auto w-full p-0 text-left font-normal"
      >
        {item}
      </Button>
    )
  }
  return item
}
