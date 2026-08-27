"use client"

/**
 * The expanded sidebar's guild group: Chats, then one row per team, pinned
 * below the conversation list as a fixed block.
 *
 * These rows pick the list's *scope*, they do not disclose a panel of their
 * own: the conversation list above shows whatever the selected row names
 * (`channel-list.tsx` filters by it), so one row is highlighted the way a
 * navigation entry is rather than turned open like an accordion header. That
 * is a deliberate change from the earlier Codex-style accordion, which cut the
 * row list in two and hoisted the open section — and Chats above it — over the
 * search field. Selecting a team then moved the search row and the whole list
 * down the rail, which read as the layout coming apart, and the rows danced
 * around a list that (outside `groupBy: "team"`) never actually followed them.
 *
 * The group's own order is the user's: team rows are drag-sortable, and the
 * order is shared with the 56px icon column (`lib/shell/team-order.ts`).
 *
 * The list's actions are not here — "new conversation" heads the whole sidebar
 * and the ⋯ menu sits on the search row, both in one fixed place
 * (`channel-list.tsx`). Every row does carry a context menu with the scope's
 * own actions — start a conversation there without selecting it first, mark it
 * read, reorder it, manage teams — the way a Discord category or a Slack
 * section does, plus the unread count of what it holds while it is not the
 * selected scope (`useGuildUnread`, the same aggregate the icon column draws).
 */
import { Fragment, useCallback, type CSSProperties, type ReactNode } from "react"
import { useTranslations } from "next-intl"
import { useRouter } from "next/navigation"
import {
  ArrowDownIcon,
  ArrowUpIcon,
  CheckCheckIcon,
  ChevronDownIcon,
  MessagesSquareIcon,
  PlusIcon,
  SettingsIcon,
} from "lucide-react"
import { useSortable } from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
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
import {
  markGuildRead,
  useGuildUnread,
  type GuildUnreadTarget,
} from "@/hooks/shell/use-guild-unread"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { SidebarRow } from "./sidebar-nav-section"
import { useShellNav } from "./use-shell-nav"

const log = loggers.ui

/** Route that owns team creation / editing — the teams section of settings. */
export const TEAM_SETTINGS_ROUTE = "/settings?section=teams"

export type GuildSectionRow = { key: "dm" } | { key: string; team: Team }

export type ActiveGuildSection = { kind: "dm" } | { kind: "team"; teamId: string }

/**
 * The group's rows, in order: Chats first — it is how you leave a team — then
 * every team as the user arranged them.
 *
 * A flat list, unlike the split this replaced: the rows sit together in one
 * block below the conversation list, so selecting one never moves the search
 * field or the list itself.
 */
export function guildSectionRows(teams: readonly Team[]): GuildSectionRow[] {
  return [{ key: "dm" }, ...teams.map((team) => ({ key: team.id, team }))]
}

/**
 * Which row is highlighted, as a plain key. A team that was selected and has
 * since been deleted leaves nothing highlighted rather than falling back to
 * Chats — the list is still scoped to that team's (now empty) set, and saying
 * "Chats" would misname what is on screen.
 */
export function activeGuildKey(active: ActiveGuildSection): string {
  return active.kind === "dm" ? "dm" : active.teamId
}

/** Compact unread pill for an unselected scope — the glyph the session rows use. */
export function GuildUnreadPill({ count, testId }: { count: number; testId?: string }) {
  if (count <= 0) return null
  return (
    <span
      className="shrink-0 rounded-pill bg-primary px-1.5 py-0.5 text-[10px] leading-none font-medium text-primary-foreground tabular-nums"
      data-testid={testId}
    >
      {count > 99 ? "99+" : count}
    </span>
  )
}

interface RowsProps {
  rows: GuildSectionRow[]
  /** Which row names the list's current scope. `null` highlights nothing. */
  activeKey: string | null
  /**
   * Start a conversation in a scope from its context menu — without selecting
   * it first. `teamId` is `null` for Chats. When absent the menu offers no
   * "new" item (the mobile Sheet has none to give).
   */
  onNewConversation?: (teamId: string | null) => void
  className?: string
  testId?: string
  /**
   * Turn the team rows into drag handles for a reorder.
   *
   * The `DndContext` and the `SortableContext` stay the caller's rather than
   * this component's, so the ids a drag may land on are exactly the ones the
   * caller persists (`channel-list.tsx`). This prop says "you are inside one"
   * — `useSortable` outside a context would silently do nothing.
   *
   * Chats is never sortable — it is the unscoped list, not a peer of the
   * teams, and it always leads.
   */
  sortable?: boolean
  /**
   * Keyboard path for the same reorder, offered in each team row's context
   * menu. The rows already spend Enter/Space on "open this section", so they
   * cannot also mean "pick this up" the way a dnd-kit keyboard sensor needs;
   * the menu is where a keyboard user moves a team instead.
   */
  onMoveTeam?: (teamId: string, delta: number) => void
  /**
   * Folded: only the row that names the current scope is drawn, with a chevron
   * beside it that unfolds the rest. The active row stays because it is the
   * one piece of state the band carries — a fold that also hid *where the list
   * is scoped* would put a narrow window back in the trap the accordion was
   * retired for. The scopes that go away take their unread counts with them,
   * so the total is drawn beside the chevron instead.
   */
  collapsed?: boolean
  /** Absent = the band is not foldable here (the caller owns no state for it). */
  onToggleCollapsed?: () => void
}

/** What a sortable row hands to the element that actually moves. */
interface GuildRowDragBinding {
  ref?: (node: HTMLElement | null) => void
  style?: CSSProperties
  dragging?: boolean
  handleProps?: Record<string, unknown>
}

/**
 * Wraps one team row in `useSortable`. A component of its own because the
 * hook cannot be called conditionally, and only *some* rows (teams, and only
 * when the caller mounted a `DndContext`) are sortable.
 */
function SortableGuildRow({
  id,
  children,
}: {
  id: string
  children: (binding: GuildRowDragBinding) => ReactNode
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
  })
  // `attributes` carries `role="button"` and `tabIndex={0}` for the case where
  // the activator is a plain div. Here it is a row that already *is* a button
  // inside a `role="listitem"` wrapper, and the sidebar runs one roving tab
  // stop across every row (`sidebar-row-roving.tsx`) — so take the two
  // announcements and leave the focus model alone.
  const handleProps: Record<string, unknown> = {
    ...listeners,
    "aria-roledescription": attributes["aria-roledescription"],
    "aria-describedby": attributes["aria-describedby"],
  }
  return (
    <>
      {children({
        ref: setNodeRef,
        style: { transform: CSS.Transform.toString(transform), transition },
        dragging: isDragging,
        handleProps,
      })}
    </>
  )
}

/**
 * The guild group as rows. One block, rendered once, below the list.
 *
 * Each row is drawn like a navigation entry — icon, label, the travelling
 * selection tint behind the selected one — because that is what it does: it
 * points the list at a scope. The right end stays free for the unread count
 * of the scopes that are not currently on screen.
 */
export function SidebarGuildSectionRows({
  rows,
  activeKey,
  onNewConversation,
  className,
  testId,
  sortable = false,
  onMoveTeam,
  collapsed = false,
  onToggleCollapsed,
}: RowsProps) {
  const t = useTranslations("desktop.channelList")
  const railT = useTranslations("desktop.guildRail")
  const router = useRouter()
  const { switchToDm, switchToTeam } = useShellNav()
  const unread = useGuildUnread()

  const markRead = useCallback((row: GuildSectionRow) => {
    const target: GuildUnreadTarget =
      row.key === "dm" ? { kind: "dm" } : { kind: "team", teamId: row.key }
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
  // Which row survives a fold — the active scope, or the first row when the
  // active one is gone (a deleted team leaves `activeKey` pointing nowhere,
  // and a band that renders no rows at all cannot be unfolded again).
  const foldKey = rows.some((row) => row.key === activeKey) ? activeKey : rows[0].key
  const foldable = Boolean(onToggleCollapsed)
  const folded = foldable && collapsed
  const shownRows = folded ? rows.filter((row) => row.key === foldKey) : rows
  const hiddenUnread = folded
    ? rows.reduce(
        (sum, row) =>
          row.key === foldKey
            ? sum
            : sum + (row.key === "dm" ? unread.dm : (unread.teams.get(row.key) ?? 0)),
        0
      )
    : 0
  return (
    <div
      role="list"
      data-testid={testId}
      className={cn("flex shrink-0 flex-col gap-px px-2", className)}
    >
      {shownRows.map((row) => {
        const active = row.key === activeKey
        // `key` is `string` on the team arm, so it does not narrow the union;
        // the `team` field is the discriminant.
        const team = "team" in row ? row.team : null
        const isDm = !team
        const label = team ? team.name : t("directMessages")
        const count = isDm ? unread.dm : (unread.teams.get(row.key) ?? 0)
        const newLabel = isDm ? t("newChat") : t("newConversation")
        const draggable = sortable && !isDm
        const renderRow = (drag: GuildRowDragBinding = {}) => (
          <ContextMenu>
            <ContextMenuTrigger asChild>
              <div
                role="listitem"
                ref={drag.ref}
                style={drag.style}
                // The whole row is the drag handle — a grip glyph would have to
                // appear on hover, and a row that grows a control when the
                // pointer arrives is what the 32px accordion was built to
                // avoid. The pointer sensor only arms after 4px of travel, so
                // a click still opens the section.
                {...drag.handleProps}
                className={cn(
                  "flex min-w-0 items-center gap-0.5",
                  draggable && "cursor-grab active:cursor-grabbing",
                  // The row stays in place as the placeholder while its clone
                  // follows the pointer; dimming is what says which one it is.
                  drag.dragging && "z-10 opacity-50"
                )}
              >
                <SidebarRow
                  active={active}
                  // Long team names truncate; the native tooltip is what the icon
                  // column's tooltip was — the way to read the whole name.
                  title={label}
                  onClick={isDm ? switchToDm : () => switchToTeam(row.key)}
                  icon={
                    team ? (
                      <AvatarBadge subject={team} size={16} textClassName="text-[9px]" />
                    ) : (
                      <MessagesSquareIcon />
                    )
                  }
                  label={label}
                  trailing={
                    active ? undefined : (
                      // Not the current scope, so its conversations are not on
                      // screen — the row says how many are waiting in there.
                      <GuildUnreadPill count={count} testId={`sidebar-guild-unread-${row.key}`} />
                    )
                  }
                  testId={isDm ? "sidebar-guild-dm" : `sidebar-guild-team-${row.key}`}
                  className={cn("w-auto flex-1", active && "font-medium")}
                />
                {foldable && row.key === foldKey ? (
                  <>
                    {/* What the fold is hiding, so it is not silent. */}
                    <GuildUnreadPill count={hiddenUnread} testId="sidebar-guild-folded-unread" />
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon"
                      // The row wrapper is the drag handle; without this the
                      // press that opens the fold also arms a team drag.
                      onPointerDown={(event) => event.stopPropagation()}
                      onClick={() => {
                        log.info("guild band fold", { folded: !folded })
                        onToggleCollapsed?.()
                      }}
                      aria-expanded={!folded}
                      aria-label={folded ? t("expandTeams") : t("collapseTeams")}
                      title={folded ? t("expandTeams") : t("collapseTeams")}
                      data-testid="sidebar-guild-fold"
                      className="size-7 shrink-0 text-muted-foreground hover:text-foreground"
                    >
                      <ChevronDownIcon
                        className={cn("size-3.5 transition-transform", folded && "-rotate-90")}
                      />
                    </Button>
                  </>
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
                  {onMoveTeam ? (
                    <>
                      <ContextMenuItem
                        onSelect={() => onMoveTeam(row.key, -1)}
                        data-testid={`sidebar-guild-menu-move-up-${row.key}`}
                      >
                        <ArrowUpIcon className="size-4" />
                        {railT("moveTeamUp")}
                      </ContextMenuItem>
                      <ContextMenuItem
                        onSelect={() => onMoveTeam(row.key, 1)}
                        data-testid={`sidebar-guild-menu-move-down-${row.key}`}
                      >
                        <ArrowDownIcon className="size-4" />
                        {railT("moveTeamDown")}
                      </ContextMenuItem>
                    </>
                  ) : null}
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
        return draggable ? (
          <SortableGuildRow key={row.key} id={row.key}>
            {renderRow}
          </SortableGuildRow>
        ) : (
          <Fragment key={row.key}>{renderRow()}</Fragment>
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
