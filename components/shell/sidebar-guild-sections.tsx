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
 *
 * A closed section hides its conversations, so its row carries what the list
 * would have shown: the number of unread conversations inside it
 * (`useGuildUnread`, the same aggregate the icon column's buttons draw). Every
 * row also has a context menu with the section's own actions — start a
 * conversation there without opening it first, mark it read, manage teams —
 * the way a Discord category or a Slack section does.
 */

import { useCallback, type ReactNode } from "react"
import { useTranslations } from "next-intl"
import { useRouter } from "next/navigation"
import { CheckCheckIcon, ChevronRightIcon, MailIcon, PlusIcon, SettingsIcon } from "lucide-react"
import { loggers } from "@cognia/logging"
import type { Team } from "@cognia/agent-config-types"
import { AvatarBadge } from "@/components/desktop/avatar-badge"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import { markGuildRead, useGuildUnread } from "@/hooks/shell/use-guild-unread"
import { cn } from "@/lib/utils"
import { SidebarRow } from "./sidebar-nav-section"
import { useShellNav } from "./use-shell-nav"

const log = loggers.ui

/** Route that owns team creation / editing — the teams section of settings. */
export const TEAM_SETTINGS_ROUTE = "/settings?section=teams"

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

/** Compact unread pill for a closed section — same glyph the session rows use. */
export function GuildUnreadPill({ count, testId }: { count: number; testId?: string }) {
  if (count <= 0) return null
  return (
    <span
      className="shrink-0 rounded-full bg-primary px-1.5 py-0.5 text-[10px] leading-none font-medium text-primary-foreground tabular-nums"
      data-testid={testId}
    >
      {count > 99 ? "99+" : count}
    </span>
  )
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
  /**
   * Start a conversation in a section from its context menu — without having
   * to open the section first. `teamId` is `null` for Direct Messages. When
   * absent the menu offers no "new" item (the mobile Sheet has none to give).
   */
  onNewConversation?: (teamId: string | null) => void
  /**
   * Element id of the block the open section discloses (the search field and
   * the conversation list). Pairs with `aria-expanded` so a screen reader can
   * follow the disclosure to what it opened, instead of announcing an
   * expanded control with no target.
   */
  panelId?: string
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
  onNewConversation,
  panelId,
  className,
  testId,
}: RowsProps) {
  const t = useTranslations("desktop.channelList")
  const railT = useTranslations("desktop.guildRail")
  const router = useRouter()
  const { switchToDm, switchToTeam } = useShellNav()
  const unread = useGuildUnread()

  const markRead = useCallback((row: GuildSectionRow) => {
    const target = row.key === "dm" ? ({ kind: "dm" } as const) : { kind: "team", teamId: row.key }
    log.info("guild mark read", target)
    void markGuildRead(target).catch((error: unknown) => {
      log.warn("guild mark read failed", { error: String(error) })
    })
  }, [])
  const manageTeams = useCallback(() => {
    log.info("guild manage teams")
    router.push(TEAM_SETTINGS_ROUTE)
  }, [router])

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
        const count = isDm ? unread.dm : (unread.teams.get(row.key) ?? 0)
        const newLabel = isDm ? t("newChat") : t("newConversation")
        return (
          <ContextMenu key={row.key}>
            <ContextMenuTrigger asChild>
              <div role="listitem" className="flex min-w-0 items-center gap-0.5">
                <SidebarRow
                  active={open}
                  highlight={false}
                  current={false}
                  aria-expanded={open}
                  aria-controls={open && panelId ? panelId : undefined}
                  // Long team names truncate; the native tooltip is what the icon
                  // column's tooltip was — the way to read the whole name.
                  title={label}
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
                    open ? (
                      archived ? (
                        <span
                          className="truncate text-xs font-normal text-muted-foreground"
                          data-testid="channel-list-archived-suffix"
                        >
                          · {t("archivedTitleSuffix")}
                        </span>
                      ) : undefined
                    ) : (
                      // Closed: the list is hidden, so the row says what it holds.
                      <GuildUnreadPill count={count} testId={`sidebar-guild-unread-${row.key}`} />
                    )
                  }
                  testId={isDm ? "sidebar-guild-dm" : `sidebar-guild-team-${row.key}`}
                  className={cn("w-auto flex-1", open && "font-medium text-foreground")}
                />
                {open && openActions ? (
                  <div
                    className="flex shrink-0 items-center"
                    data-testid="sidebar-guild-open-actions"
                  >
                    {openActions}
                  </div>
                ) : null}
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent data-testid={`sidebar-guild-menu-${row.key}`}>
              {onNewConversation ? (
                <ContextMenuItem
                  onSelect={() => {
                    log.info("guild new conversation via context menu", { key: row.key })
                    onNewConversation(isDm ? null : row.key)
                  }}
                  data-testid={`sidebar-guild-menu-new-${row.key}`}
                >
                  <PlusIcon className="size-4" />
                  {newLabel}
                </ContextMenuItem>
              ) : null}
              <ContextMenuItem
                disabled={count === 0}
                onSelect={() => markRead(row)}
                data-testid={`sidebar-guild-menu-mark-read-${row.key}`}
              >
                <CheckCheckIcon className="size-4" />
                {railT("markAllRead")}
              </ContextMenuItem>
              {isDm ? null : (
                <>
                  <ContextMenuSeparator />
                  <ContextMenuItem
                    onSelect={manageTeams}
                    data-testid={`sidebar-guild-menu-manage-${row.key}`}
                  >
                    <SettingsIcon className="size-4" />
                    {railT("manageTeams")}
                  </ContextMenuItem>
                </>
              )}
            </ContextMenuContent>
          </ContextMenu>
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
          router.push(TEAM_SETTINGS_ROUTE)
        }}
        icon={<PlusIcon />}
        label={t("createTeam")}
        testId="sidebar-guild-create-team"
        className="text-muted-foreground/80"
      />
    </div>
  )
}
