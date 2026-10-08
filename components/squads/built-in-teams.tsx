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
 * They are shown here in their own foldable group of rows, labelled built-in
 * and read-only, with the actions the Team model actually supports:
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
import {
  ChevronRightIcon,
  CopyIcon,
  MessagesSquareIcon,
  SettingsIcon,
  UsersIcon,
} from "lucide-react"

import type { Team } from "@cognia/agent-config-types"
import { useShellNav } from "@/components/shell/use-shell-nav"
import type { SquadListVariant } from "@/components/squads/squad-list-pane"
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
  /**
   * What the rows stand on, matching the Squad list above them: the rail's own
   * ground on a desktop, one grouped surface over the wallpaper on a phone.
   */
  variant?: SquadListVariant
  /**
   * Whether the group starts unfolded. The list opens it while the workspace
   * has no Squads, when these are the only thing to use, and folds it under its
   * heading once there are, when they are reference material.
   *
   * A search that matches a built-in Team always shows the match: a folded
   * group hiding the one hit would read as "no results".
   */
  defaultOpen?: boolean
  className?: string
}

export function BuiltInTeamsSection({
  teams,
  query = "",
  variant = "rail",
  defaultOpen = true,
  className,
}: BuiltInTeamsSectionProps) {
  const t = useTranslations("squads")
  const headingId = useId()
  const contentId = useId()
  // `null` until the reader toggles it, so the default can follow the list.
  // The list answers "has Squads" only once its Dexie read lands, after this
  // section first renders, and a default captured at mount kept the group
  // unfolded beside Squads that arrived a moment later.
  const [chosen, setChosen] = useState<boolean | null>(null)
  const visible = filterBuiltInTeams(teams, query)
  if (visible.length === 0) return null
  const searching = query.trim().length > 0
  const open = chosen ?? defaultOpen
  const expanded = open || searching

  const rows = visible.map((team) => (
    <li key={team.id}>
      <BuiltInTeamRow team={team} />
    </li>
  ))

  return (
    <section
      aria-labelledby={headingId}
      className={cn("@container/builtins space-y-1", className)}
      data-testid="squad-builtin-teams"
      data-open={expanded}
    >
      <div className="flex items-center justify-between gap-2 pt-1">
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={contentId}
          disabled={searching}
          onClick={() => setChosen(!open)}
          className="-mx-0.5 flex min-w-0 items-center gap-1 rounded-sm px-0.5 py-0.5 text-left hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
          data-testid="squad-builtin-toggle"
        >
          <ChevronRightIcon
            aria-hidden
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground transition-transform",
              expanded && "rotate-90"
            )}
          />
          <h3 id={headingId} className="truncate text-xs font-semibold text-muted-foreground">
            {t("builtIn.title")}
          </h3>
          <span className="text-xs tabular-nums text-muted-foreground">{visible.length}</span>
        </button>
        <Link
          href={settingsHref("teams")}
          title={t("builtIn.manage")}
          className="inline-flex shrink-0 items-center gap-1 rounded-sm px-1 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
          data-testid="squad-builtin-manage"
        >
          <SettingsIcon aria-hidden className="size-3" />
          {/* The heading keeps the room in a narrow rail; the link keeps its
              name for assistive tech either way. */}
          <span className="sr-only @[16rem]/builtins:not-sr-only">{t("builtIn.manage")}</span>
        </Link>
      </div>
      {expanded ? (
        <div id={contentId} className="space-y-1.5">
          <p className="px-0.5 text-[11px] text-muted-foreground">{t("builtIn.description")}</p>
          {variant === "page" ? (
            <Surface asChild layer="raised" radius="panel">
              <ul
                className="divide-y divide-border/60 overflow-hidden border"
                data-testid="squad-builtin-list"
              >
                {rows}
              </ul>
            </Surface>
          ) : (
            <ul className="space-y-0.5" data-testid="squad-builtin-list">
              {rows}
            </ul>
          )}
        </div>
      ) : null}
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

  // A row with its two verbs, not a card with a button bar. Duplicate is the
  // rarer verb, so it is the icon; Open keeps its word because it is the one
  // people come here for. Where the rail is narrow the verbs drop under the
  // name instead of squeezing it: beside a badge and two buttons, a 230px
  // rail left the name one letter wide. It reflows off the list's own width
  // (`@container/builtins`), because the rail is resizable and the window
  // says nothing about it.
  return (
    <div
      className="flex flex-col gap-1.5 rounded-md px-2.5 py-2 hover:bg-accent/40 @xs/builtins:flex-row @xs/builtins:items-center @xs/builtins:gap-2.5"
      data-testid={`squad-builtin-row-${team.id}`}
    >
      <div className="flex min-w-0 flex-1 items-start gap-2.5">
        <UsersIcon aria-hidden className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="min-w-0 truncate text-sm font-medium">{team.name}</span>
            <Badge variant="outline" className="shrink-0 text-[10px]">
              {t("builtIn.badge")}
            </Badge>
          </div>
          <p className="mt-0.5 truncate text-xs text-muted-foreground">
            {t("fleet.memberCount", { count: team.members?.length ?? 0 })}
            {team.description ? ` · ${team.description}` : ""}
          </p>
        </div>
      </div>
      <div className="-ml-2 flex shrink-0 items-center gap-0.5 pl-6 @xs/builtins:ml-0 @xs/builtins:pl-0">
        <Button
          type="button"
          size="sm"
          variant="ghost"
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
          size="icon"
          variant="ghost"
          className="size-7"
          disabled={duplicating}
          aria-busy={duplicating}
          onClick={() => void onDuplicate()}
          aria-label={t("builtIn.duplicateAria", { name: team.name })}
          title={t("builtIn.duplicate")}
          data-testid={`squad-builtin-duplicate-${team.id}`}
        >
          <CopyIcon aria-hidden className="size-3.5" />
        </Button>
      </div>
    </div>
  )
}
