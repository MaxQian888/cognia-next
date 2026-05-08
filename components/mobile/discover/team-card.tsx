"use client"

import Link from "next/link"
import { useTranslations } from "next-intl"
import { UsersIcon } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import type { Team } from "@/lib/claude/types"
import { cn } from "@/lib/utils"

export interface TeamCardProps {
  team: Team
  className?: string
}

export function TeamCard({ team, className }: TeamCardProps) {
  const t = useTranslations("mobile.discover")
  const memberCount = team.members?.length ?? 0
  return (
    <Link
      href={`/agent-teams/${encodeURIComponent(team.id)}`}
      className="block"
      data-testid={`team-card-${team.id}`}
    >
      <div
        className={cn(
          "flex items-start gap-3 rounded-md border border-border bg-card p-3",
          "active:bg-muted/50 transition-colors",
          className
        )}
      >
        <span
          aria-hidden
          className="flex size-12 shrink-0 items-center justify-center rounded-md bg-secondary text-secondary-foreground"
        >
          <UsersIcon className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-sm font-semibold">{team.name}</h3>
            {team.isBuiltIn ? (
              <Badge variant="outline" className="text-[10px]">
                {t("builtInBadge")}
              </Badge>
            ) : null}
          </div>
          <p className="text-xs text-muted-foreground">
            {t("memberCount", { count: memberCount })}
            {team.description ? <span> · {team.description}</span> : null}
          </p>
        </div>
      </div>
    </Link>
  )
}
