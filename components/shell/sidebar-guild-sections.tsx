"use client"

/**
 * The sidebar's guild rows: Chats, then one row per team.
 *
 * These rows pick the list's *scope*, they do not disclose a panel of their
 * own: the conversation list above shows whatever the selected row names
 * (`channel-list.tsx` filters by it), so one row is highlighted the way a
 * navigation entry is rather than turned open like an accordion header.
 *
 * This band survives only on the *compact* surfaces — the mobile Sheet and
 * the collapsed-rail peek panel — where there is no room for the scope tree.
 * The merged desktop rail replaced it with `groupBy: "team"` sections inside
 * the scrollable list itself (the Codex-style scope tree), so the rows' old
 * job — naming the scope of a filtered list — no longer exists there.
 *
 * The group's own order is the user's: team rows are drag-sortable, and the
 * order is shared with the 56px icon column (`lib/shell/team-order.ts`).
 *
 * The list's actions are not here — "new conversation" heads the whole sidebar
 * and the ⋯ menu sits on the search row, both in one fixed place
 * (`channel-list.tsx`). `GuildScopeMenuItems` is the shared per-scope context
 * menu — the band's rows and the scope tree's group headers serve the same
 * actions from it.
 */
import { Fragment, useCallback, type CSSProperties, type ReactNode } from "react"
import { useTranslations } from "next-intl"
import { useRouter } from "next/navigation"
import {
  ArrowDownIcon,
  ArrowUpIcon,
  BellIcon,
  BellOffIcon,
  CheckCheckIcon,
  ChevronDownIcon,
  MessagesSquareIcon,
  PencilIcon,
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
  useGuildUnreadScope,
  type GuildUnreadScope,
  type GuildUnreadTarget,
} from "@/hooks/shell/use-guild-unread"
import { useTeamMute, useVisibleGuildUnread } from "@/hooks/shell/use-team-mute"
import { Button } from "@/components/ui/button"
import { teamSettingsHref } from "@/lib/settings/deep-link"
import { cn } from "@/lib/utils"
import { CountPill, SidebarRow } from "./sidebar-nav-section"
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

/**
 * A muted team's glyph, where its unread pill would be. Decorative: the row's
 * or button's accessible name already says "muted".
 */
export function GuildMutedGlyph({ className, testId }: { className?: string; testId?: string }) {
  return (
    <BellOffIcon
      aria-hidden
      data-testid={testId}
      className={cn("size-3 shrink-0 text-muted-foreground/70", className)}
    />
  )
}

/** Compact unread pill for an unselected scope — the glyph the session rows use. */
export function GuildUnreadPill({ count, testId }: { count: number; testId?: string }) {
  return <CountPill count={count} testId={testId} />
}

/**
 * The per-scope context menu, as items — the caller supplies the
 * `ContextMenuContent` so the same actions serve both surfaces that draw a
 * scope: the band's rows here, and the merged rail's collapsible group
 * headers in `channel-list.tsx`. One menu, so "new conversation in this
 * scope", "mark all read", and reorder/manage never drift between the two.
 *
 * The icon rail's guild buttons (`guild-rail.tsx`) serve the same items too,
 * so "edit this team", "mute it" and "move it" are one implementation in all
 * three places.
 *
 * `teamId` of `null` names the Chats scope — the direct-conversation group —
 * which is never reorderable, cannot be muted and has no team settings.
 */
export function GuildScopeMenuItems({
  teamId,
  unreadCount,
  onNewConversation,
  onMoveTeam,
  teamPosition,
  unreadScope,
  testIdPrefix = "sidebar-guild-menu",
}: {
  teamId: string | null
  unreadCount: number
  onNewConversation?: (teamId: string | null) => void
  onMoveTeam?: (teamId: string, delta: number) => void
  /**
   * Where the team sits in the order `onMoveTeam` moves it through. With it,
   * "Move up" is disabled on the first team and "Move down" on the last — an
   * item that would do nothing should say so. Callers that cannot tell leave
   * it out and both stay enabled (the move is then a silent no-op at an end).
   */
  teamPosition?: { index: number; count: number }
  /**
   * The workspace reach "mark all read" clears. Defaults to the shared badge
   * scope; the merged rail passes the reach its own rows were loaded with,
   * since it groups on the team axis whatever grouping is stored.
   */
  unreadScope?: GuildUnreadScope
  /** `data-testid` prefix — each surface keeps its own stable ids. */
  testIdPrefix?: string
}) {
  const t = useTranslations("desktop.channelList")
  const railT = useTranslations("desktop.guildRail")
  const router = useRouter()
  const sharedScope = useGuildUnreadScope()
  const { isMuted, setMuted } = useTeamMute()
  const scope = unreadScope ?? sharedScope
  const key = teamId ?? "dm"
  const muted = teamId ? isMuted(teamId) : false
  const atStart = teamPosition ? teamPosition.index <= 0 : false
  const atEnd = teamPosition ? teamPosition.index >= teamPosition.count - 1 : false
  const markRead = useCallback(() => {
    const target: GuildUnreadTarget = teamId ? { kind: "team", teamId } : { kind: "dm" }
    log.info("guild mark read", target)
    void markGuildRead(target, scope).catch((error: unknown) => {
      log.warn("guild mark read failed", { error: String(error) })
    })
  }, [teamId, scope])
  const manageTeams = useCallback(() => {
    log.info("guild manage teams")
    router.push(TEAM_SETTINGS_ROUTE)
  }, [router])
  const editTeam = useCallback(() => {
    if (!teamId) return
    log.info("guild edit team", { teamId })
    router.push(teamSettingsHref(teamId))
  }, [router, teamId])
  const toggleMute = useCallback(() => {
    if (!teamId) return
    log.info("guild team mute", { teamId, muted: !muted })
    void setMuted(teamId, !muted).catch((error: unknown) => {
      log.warn("guild team mute failed", { teamId, error: String(error) })
    })
  }, [teamId, muted, setMuted])
  return (
    <>
      {onNewConversation ? (
        <ContextMenuItem
          onSelect={() => {
            log.info("guild new conversation via context menu", { key })
            onNewConversation(teamId)
          }}
          data-testid={`${testIdPrefix}-new-${key}`}
        >
          <PlusIcon className="size-4" />
          {teamId ? t("newConversation") : t("newChat")}
        </ContextMenuItem>
      ) : null}
      <ContextMenuItem
        disabled={unreadCount === 0}
        onSelect={markRead}
        data-testid={`${testIdPrefix}-mark-read-${key}`}
      >
        <CheckCheckIcon className="size-4" />
        {railT("markAllRead")}
      </ContextMenuItem>
      {teamId ? (
        <>
          <ContextMenuItem onSelect={toggleMute} data-testid={`${testIdPrefix}-mute-${key}`}>
            {muted ? <BellIcon className="size-4" /> : <BellOffIcon className="size-4" />}
            {muted ? railT("unmuteTeam") : railT("muteTeam")}
          </ContextMenuItem>
          <ContextMenuSeparator />
          {onMoveTeam ? (
            <>
              <ContextMenuItem
                disabled={atStart}
                onSelect={() => onMoveTeam(teamId, -1)}
                data-testid={`${testIdPrefix}-move-up-${key}`}
              >
                <ArrowUpIcon className="size-4" />
                {railT("moveTeamUp")}
              </ContextMenuItem>
              <ContextMenuItem
                disabled={atEnd}
                onSelect={() => onMoveTeam(teamId, 1)}
                data-testid={`${testIdPrefix}-move-down-${key}`}
              >
                <ArrowDownIcon className="size-4" />
                {railT("moveTeamDown")}
              </ContextMenuItem>
              <ContextMenuSeparator />
            </>
          ) : null}
          <ContextMenuItem onSelect={editTeam} data-testid={`${testIdPrefix}-edit-${key}`}>
            <PencilIcon className="size-4" />
            {railT("editTeam")}
          </ContextMenuItem>
          <ContextMenuItem onSelect={manageTeams} data-testid={`${testIdPrefix}-manage-${key}`}>
            <SettingsIcon className="size-4" />
            {railT("manageTeams")}
          </ContextMenuItem>
        </>
      ) : null}
    </>
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
  const { switchToDm, switchToTeam } = useShellNav()
  // Muted teams already left this aggregate, so neither their own pill nor
  // the folded total below counts them.
  const unread = useVisibleGuildUnread()
  const { isMuted } = useTeamMute()
  const teamKeys = rows.filter((row) => "team" in row).map((row) => row.key)

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
        const muted = team ? isMuted(team.id) : false
        const count = isDm ? unread.dm : (unread.teams.get(row.key) ?? 0)
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
                  aria-label={muted ? railT("teamMuted", { name: label }) : undefined}
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
                    muted ? (
                      // Muted: nothing waiting in there is announced, and the
                      // glyph says why the pill is gone.
                      <GuildMutedGlyph testId={`sidebar-guild-muted-${row.key}`} />
                    ) : active ? undefined : (
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
              <GuildScopeMenuItems
                teamId={isDm ? null : row.key}
                unreadCount={count}
                onNewConversation={onNewConversation}
                onMoveTeam={onMoveTeam}
                teamPosition={
                  isDm ? undefined : { index: teamKeys.indexOf(row.key), count: teamKeys.length }
                }
              />
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
