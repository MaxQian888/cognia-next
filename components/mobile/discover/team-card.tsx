"use client"

import Link from "next/link"
import { useTranslations } from "next-intl"
import { UsersIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Item, ItemContent, ItemDescription, ItemMedia, ItemTitle } from "@/components/ui/item"
import type { Team } from "@cognia/agent-config-types"
import { cn } from "@/lib/utils"

export interface TeamCardProps {
  team: Team
  className?: string
}

export function TeamCard({ team, className }: TeamCardProps) {
  const t = useTranslations("discover")
  const memberCount = team.members?.length ?? 0
  return (
    <Link
      href={`/agent-teams/workspace?teamId=${encodeURIComponent(team.id)}`}
      className="block"
      data-testid={`team-card-${team.id}`}
    >
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
    </Link>
  )
}
