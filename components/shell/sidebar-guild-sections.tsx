"use client"

/**
 * The expanded sidebar's guild accordion: Direct Messages, then one section
 * per team, one of them open. The open section's body is the conversation
 * list itself (`ChannelListBody` — search field, filters, sessions), so this
 * module renders only the header rows and tells the caller where to put the
 * list: `splitGuildSections` returns the headers that go *above* it (ending
 * with the open one) and the ones that go *below* it. Codex-style: the rows
 * that are closed stay a single line each; picking one moves the list under it.
 *
 * Which section is open is `selectedGuild` (`useShellNav`), so the header
 * rows here, the icon column and the chat pane all agree.
 */

import type { ReactNode } from "react"
import { useTranslations } from "next-intl"
import { useRouter } from "next/navigation"
import { ChevronRightIcon, MailIcon, PlusIcon } from "lucide-react"
import { loggers } from "@cognia/logging"
import type { Team } from "@cognia/agent-config-types"
import { AvatarBadge } from "@/components/desktop/avatar-badge"
import { cn } from "@/lib/utils"
import { SidebarRow } from "./sidebar-nav-section"
import { useShellNav } from "./use-shell-nav"

const log = loggers.ui

export type GuildSectionRow = { key: "dm" } | { key: string; team: Team }

export type ActiveGuildSection = { kind: "dm" } | { kind: "team"; teamId: string }

/**
 * Order the accordion — DM first, then teams as listed — and cut it at the
 * open section: `before` ends with the open row (the list renders right after
 * it), `after` is everything below the list. A selected team that is no
 * longer in `teams` (deleted while selected) leaves nothing open: every header
 * goes above the list, which then reads as an orphan block until the user
 * picks a section.
 */
export function splitGuildSections(
  teams: readonly Team[],
  active: ActiveGuildSection
): { before: GuildSectionRow[]; after: GuildSectionRow[]; openKey: string | null } {
  const rows: GuildSectionRow[] = [{ key: "dm" }, ...teams.map((team) => ({ key: team.id, team }))]
  const openKey = active.kind === "dm" ? "dm" : active.teamId
  const index = rows.findIndex((row) => row.key === openKey)
  if (index === -1) return { before: rows, after: [], openKey: null }
  return { before: rows.slice(0, index + 1), after: rows.slice(index + 1), openKey }
}

interface RowsProps {
  rows: GuildSectionRow[]
  /** Which row is the open one — the caller's `openKey` from the split. */
  openKey: string | null
  /**
   * Suffix on the open row when the list is showing archived conversations
   * (the archived toggle lives behind the list's ⋯ menu; the header says
   * where you are).
   */
  archived?: boolean
  /**
   * The open section's own actions (new conversation, list menu), drawn at
   * the right end of its header row — a section heads its content the way a
   * Discord category does, with "+" on the heading. Sits *beside* the row
   * button, not inside it: buttons do not nest.
   */
  openActions?: ReactNode
  className?: string
  testId?: string
}

/**
 * A run of accordion header rows. Render once with `before` above the list
 * and once with `after` below it.
 *
 * Disclosure reads from the left — `›` closed, `⌄` open — the way a Finder or
 * Codex tree does, so the right end stays free for the open section's
 * actions; the open row is a heading (bold, no selection tint), because
 * "which section is open" is structure, not a choice among peers.
 */
export function SidebarGuildSectionRows({
  rows,
  openKey,
  archived,
  openActions,
  className,
  testId,
}: RowsProps) {
  const t = useTranslations("desktop.channelList")
  const { switchToDm, switchToTeam } = useShellNav()
  if (rows.length === 0) return null
  return (
    <div
      role="list"
      data-testid={testId}
      className={cn("flex shrink-0 flex-col gap-px px-2", className)}
    >
      {rows.map((row) => {
        const open = row.key === openKey
        const isDm = row.key === "dm"
        const label = isDm ? t("directMessages") : row.team.name
        return (
          <div role="listitem" key={row.key} className="flex min-w-0 items-center gap-0.5">
            <SidebarRow
              active={open}
              highlight={false}
              current={false}
              aria-expanded={open}
              onClick={isDm ? switchToDm : () => switchToTeam(row.key)}
              leading={
                <ChevronRightIcon
                  aria-hidden
                  className={cn(
                    "text-muted-foreground/60 transition-transform duration-200 motion-reduce:transition-none",
                    open && "rotate-90"
                  )}
                />
              }
              icon={
                isDm ? (
                  <MailIcon />
                ) : (
                  <AvatarBadge subject={row.team} size={16} textClassName="text-[9px]" />
                )
              }
              label={label}
              trailing={
                open && archived ? (
                  <span
                    className="truncate text-xs font-normal text-muted-foreground"
                    data-testid="channel-list-archived-suffix"
                  >
                    · {t("archivedTitleSuffix")}
                  </span>
                ) : undefined
              }
              testId={isDm ? "sidebar-guild-dm" : `sidebar-guild-team-${row.key}`}
              className={cn("w-auto flex-1", open && "font-medium text-foreground")}
            />
            {open && openActions ? (
              <div className="flex shrink-0 items-center" data-testid="sidebar-guild-open-actions">
                {openActions}
              </div>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

/**
 * "Create team" — the accordion's last row. Same destination the icon
 * column's + button used (`DesktopAppShell.handleCreateTeam`): the teams
 * section of settings, which owns the creation form.
 */
export function SidebarCreateTeamRow({ className }: { className?: string }) {
  const t = useTranslations("desktop.guildRail")
  const router = useRouter()
  return (
    <div className={cn("shrink-0 px-2", className)}>
      <SidebarRow
        current={false}
        onClick={() => {
          log.info("guild create team click")
          router.push("/settings?section=teams")
        }}
        icon={<PlusIcon />}
        label={t("createTeam")}
        testId="sidebar-guild-create-team"
        className="text-muted-foreground/80"
      />
    </div>
  )
}
