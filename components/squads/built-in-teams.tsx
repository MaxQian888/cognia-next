"use client"

/**
 * The built-in Teams, shown on `/squads` beside the user's Squads.
 *
 * The chat sidebar lists four ready-made scopes (Brainstorm, Code Review, Doc
 * Polishers, Research). They are `team_builtin_*` rows of the Dexie `teams`
 * table: guilds of Characters. `/squads` lists Squads, which are `AgentTeam`s
 * in a different store, so the page said "No Squads yet · 0 Squads" while the
 * sidebar offered four squad-looking scopes, with no hint where they came from
 * or how to make one of your own.
 *
 * They are shown here in their own section, labelled built-in and read-only,
 * with the actions the Team model actually supports:
 *  - Open: switch the chat scope to the Team (the sidebar's own action).
 *  - Duplicate: `duplicateTeam` makes an editable user Team. The data model has
 *    no Team → Squad conversion, so the copy is a Team, edited under
 *    Settings → Teams, which the success toast links to.
 * The Squad count and empty state keep counting user Squads only.
 */

import { useId, useMemo, useState } from "react"
import Link from "next/link"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { toast } from "sonner"
import { CopyIcon, MessagesSquareIcon, SettingsIcon, UsersIcon } from "lucide-react"

import type { Team } from "@cognia/agent-config-types"
import { useShellNav } from "@/components/shell/use-shell-nav"
import { Surface } from "@/components/surface/surface"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { useOrderedTeams } from "@/hooks/shell/use-ordered-teams"
import { duplicateTeam } from "@/lib/db/teams"
import { settingsHref } from "@/lib/settings/deep-link"
import { cn } from "@/lib/utils"

export interface BuiltInTeamsState {
  /** Built-in Teams, in the sidebar's order. Empty while loading. */
  teams: readonly Team[]
  /** True until the first `teams` read resolves. */
  loading: boolean
}

/**
 * The built-in Teams, read through the same hook the sidebar uses, so this
 * list and the sidebar's scopes cannot disagree about which exist or in what
 * order.
 */
export function useBuiltInTeams(): BuiltInTeamsState {
  const { teams } = useOrderedTeams()
  return useMemo(
    () => ({
      teams: (teams ?? []).filter((team) => team.isBuiltIn === true),
      loading: teams === undefined,
    }),
    [teams]
  )
}

/** Case-insensitive name / description match; a blank query keeps every Team. */
export function filterBuiltInTeams(teams: readonly Team[], query: string): Team[] {
  const needle = query.trim().toLowerCase()
  if (needle.length === 0) return [...teams]
  return teams.filter(
    (team) =>
      team.name.toLowerCase().includes(needle) ||
      (team.description ?? "").toLowerCase().includes(needle)
  )
}

export interface BuiltInTeamsSectionProps {
  teams: readonly Team[]
  /** The Squad list's search text; the section narrows with it. */
  query?: string
  className?: string
}

export function BuiltInTeamsSection({ teams, query = "", className }: BuiltInTeamsSectionProps) {
  const t = useTranslations("squads")
  const headingId = useId()
  const visible = filterBuiltInTeams(teams, query)
  if (visible.length === 0) return null

  return (
    <section
      aria-labelledby={headingId}
      className={cn("space-y-1.5", className)}
      data-testid="squad-builtin-teams"
    >
      <div className="flex items-center justify-between gap-2 px-0.5 pt-2">
        <h3 id={headingId} className="text-xs font-semibold text-muted-foreground">
          {t("builtIn.title")}
        </h3>
        <Link
          href={settingsHref("teams")}
          className="inline-flex items-center gap-1 rounded-sm px-1 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
          data-testid="squad-builtin-manage"
        >
          <SettingsIcon aria-hidden className="size-3" />
          {t("builtIn.manage")}
        </Link>
      </div>
      <p className="px-0.5 text-[11px] text-muted-foreground">{t("builtIn.description")}</p>
      <ul className="space-y-1.5" data-testid="squad-builtin-list">
        {visible.map((team) => (
          <li key={team.id}>
            <BuiltInTeamRow team={team} />
          </li>
        ))}
      </ul>
    </section>
  )
}

function BuiltInTeamRow({ team }: { team: Team }) {
  const t = useTranslations("squads")
  const router = useRouter()
  const { switchToTeam } = useShellNav()
  const [duplicating, setDuplicating] = useState(false)

  const onDuplicate = async () => {
    if (duplicating) return
    setDuplicating(true)
    try {
      const copy = await duplicateTeam(team.id)
      toast.success(t("builtIn.duplicated", { name: copy.name }), {
        action: {
          label: t("builtIn.editCopy"),
          onClick: () => router.push(settingsHref("teams")),
        },
      })
    } catch (err) {
      toast.error(t("builtIn.duplicateFailed", { name: team.name }), {
        description: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setDuplicating(false)
    }
  }

  return (
    <Surface asChild layer="raised" radius="control">
      <div className="border p-2.5" data-testid={`squad-builtin-row-${team.id}`}>
        <div className="flex items-center gap-2">
          <UsersIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate text-xs font-medium">{team.name}</span>
          <Badge variant="outline" className="shrink-0 text-[10px]">
            {t("builtIn.badge")}
          </Badge>
        </div>
        <p className="mt-0.5 truncate pl-5.5 text-[10px] text-muted-foreground">
          {t("fleet.memberCount", { count: team.members?.length ?? 0 })}
          {team.description ? ` · ${team.description}` : ""}
        </p>
        <div className="mt-2 flex flex-wrap gap-1.5 pl-5.5">
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="h-7 gap-1 px-2 text-xs"
            onClick={() => switchToTeam(team.id)}
            aria-label={t("builtIn.openAria", { name: team.name })}
            data-testid={`squad-builtin-open-${team.id}`}
          >
            <MessagesSquareIcon aria-hidden className="size-3.5" />
            {t("builtIn.open")}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            className="h-7 gap-1 px-2 text-xs"
            disabled={duplicating}
            aria-busy={duplicating}
            onClick={() => void onDuplicate()}
            aria-label={t("builtIn.duplicateAria", { name: team.name })}
            data-testid={`squad-builtin-duplicate-${team.id}`}
          >
            <CopyIcon aria-hidden className="size-3.5" />
            {t("builtIn.duplicate")}
          </Button>
        </div>
      </div>
    </Surface>
  )
}
