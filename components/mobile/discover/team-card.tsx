"use client"

import Link from "next/link"
import { useTranslations } from "next-intl"
import { UsersIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Item, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@/components/ui/item"
import type { Team } from "@cognia/agent-config-types"
import { cn } from "@/lib/utils"

export interface TeamCardProps {
  team: Team
  /**
   * Select the team in place (the Discover item sheet). Without it the card is
   * a link to that same detail. It used to link to `/squads?id=`, but a Team
   * (a guild of Characters) is not a Squad (`AgentTeam`), so that page opened
   * an empty inspector.
   */
  onSelect?: (team: Team) => void
  className?: string
}

/** The Discover detail for a Team, the surface its actions live on. */
export function teamDetailHref(teamId: string): string {
  return `/discover?category=teams&item=${encodeURIComponent(teamId)}`
}

export function TeamCard({ team, onSelect, className }: TeamCardProps) {
  const t = useTranslations("discover")
  const memberCount = team.members?.length ?? 0
  const item = (
    <Item
      variant="outline"
      size="sm"
      className={cn("flex-nowrap bg-card transition-colors active:bg-muted/50", className)}
    >
      <ItemMedia
        variant="icon"
        className="size-12 rounded-md bg-secondary text-secondary-foreground"
      >
        <UsersIcon className="size-5" />
      </ItemMedia>
      <ItemContent>
        <ItemTitle className="flex items-center gap-2 text-sm">
          <span className="truncate">{team.name}</span>
          {team.isBuiltIn ? (
            <Badge variant="outline" className="text-[10px]">
              {t("builtInBadge")}
            </Badge>
          ) : null}
        </ItemTitle>
        <ItemDescription className="text-xs">
          {t("memberCount", { count: memberCount })}
          {team.description ? <span> · {team.description}</span> : null}
        </ItemDescription>
      </ItemContent>
    </Item>
  )
  if (onSelect) {
    return (
      <Button
        type="button"
        variant="ghost"
        onClick={() => onSelect(team)}
        className="block h-auto w-full p-0 text-left font-normal"
        data-testid={`team-card-${team.id}`}
      >
        {item}
      </Button>
    )
  }
  return (
    <Link href={teamDetailHref(team.id)} className="block" data-testid={`team-card-${team.id}`}>
      {item}
    </Link>
  )
}
