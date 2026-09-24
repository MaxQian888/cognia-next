"use client"

/**
 * One conversation in the mobile conversation list.
 *
 * Memoized, and every prop is either a primitive, a row the session live query
 * shares structurally (`useSessions` keeps an unchanged `ChatSession` at the
 * same identity across emissions), a lookup object that only changes with its
 * own table, or an id-taking callback the list keeps stable. So a keystroke in
 * the search box, a scroll frame, or a write to some other conversation
 * re-renders none of the rows already on screen.
 *
 * Reads the same display preferences as the desktop row (`session-row.tsx`):
 * density, the preview line, timestamps, custom icons and the metadata line.
 * `titleMotion` is the one it does not honour — that is the desktop's
 * hover-to-scroll marquee for overflowing titles, and a touch screen has no
 * hover to start it, so an overflowing title ellipsizes instead.
 *
 * Gestures, all on the same row:
 *   - tap opens the conversation;
 *   - swipe right reveals Pin; swipe left reveals More / Archive / Delete;
 *   - long-press (or a right-click / the context-menu key) opens the full
 *     action sheet, which is the one place every action is reachable from,
 *     including by keyboard and screen reader.
 */

import { memo, useEffect, useMemo, useRef, useState } from "react"
import { useFormatter, useNow, useTimeZone, useTranslations } from "next-intl"
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  BotIcon,
  BoxesIcon,
  CpuIcon,
  HashIcon,
  LockKeyholeIcon,
  MessageSquareIcon,
  MessageSquareTextIcon,
  MoreHorizontalIcon,
  PinIcon,
  PinOffIcon,
  Trash2Icon,
  UsersIcon,
  WaypointsIcon,
} from "lucide-react"

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Input } from "@/components/ui/input"
import { LongPress } from "@/components/interactions/long-press"
import { SwipeRow, type SwipeAction } from "@/components/interactions/swipe-row"
import { PlatformBadge } from "@/components/inbox/platform-badge"
import { getModelDisplayName, getProviderDisplayName } from "@/lib/ai/icons"
import { ANTHROPIC_DEFAULT_MODEL } from "@/lib/ai/provider-default-model"
import {
  CONVERSATION_TIMESTAMP_FORMATS,
  conversationTimestampShape,
} from "@/lib/chat/conversation-timestamp"
import type { ConversationGroupAxis } from "@/lib/chat/conversation-list-model"
import { avatarColor, avatarGlyph, type AvatarSubject } from "@/lib/ui/avatar"
import { cn } from "@/lib/utils"
import type {
  Character,
  ChatSession,
  ConversationSidebarDensity,
  ConversationSidebarMetadata,
  Team,
} from "@cognia/agent-config-types"

/** Width of one swipe action. Three on the trailing side fit a 262px row. */
export const MOBILE_CHANNEL_SWIPE_ACTION_WIDTH = 64

export type MobileChannelSwipeActionId = "pin" | "archive" | "delete" | "more"

/** Display preferences, resolved once by the list and shared by every row. */
export interface MobileChannelRowSettings {
  density: ConversationSidebarDensity
  showPreview: boolean
  showTimestamps: boolean
  showCustomIcons: boolean
  metadataFields: readonly ConversationSidebarMetadata[]
  defaultModel?: string
  defaultProvider?: string
  /**
   * The axis the rows are currently grouped under, or `null` for a flat list
   * (a search, `groupBy: "none"`, date buckets). A metadata field that repeats
   * the section header above the row is dropped.
   */
  groupAxis: ConversationGroupAxis | null
}

export interface MobileChannelRowProps {
  session: ChatSession
  active: boolean
  /** Unread count to badge; `0` hides the badge (including when badges are off). */
  unread: number
  /** Surfaced only because the query hit its message content. */
  contentMatch: boolean
  character?: Character
  team?: Team
  workspaceName?: string
  settings: MobileChannelRowSettings
  /** Show the inline rename field instead of the row. */
  renaming: boolean
  /** Id of the shared "long-press for more" hint the row is described by. */
  actionsHintId: string
  onSelect: (id: string) => void
  onOpenActions: (id: string) => void
  onSwipeAction: (id: string, action: MobileChannelSwipeActionId) => void
  onCommitRename: (id: string, title: string) => void
  onCancelRename: (id: string) => void
  /**
   * The list's day clock (`useConversationDayClock`): moves once per calendar
   * day in the user's zone, so a "14:32" stamped yesterday turns into a
   * weekday at midnight. A plain number, so every row shares one reading and
   * the memo holds between days. Absent → the row's mount time.
   */
  now?: number
}

export interface MobileChannelRowMetadataItem {
  kind: ConversationSidebarMetadata
  value: string
}

const METADATA_ICON = {
  agent: BotIcon,
  model: CpuIcon,
  provider: WaypointsIcon,
  workspace: BoxesIcon,
} satisfies Record<ConversationSidebarMetadata, typeof BotIcon>

/**
 * The row's metadata line, in the user's chosen field order. Same field
 * resolution as the desktop sidebar (`channel-list.tsx`): the conversation's
 * own override, then its agent's, then the global default.
 */
export function resolveMobileRowMetadata({
  session,
  character,
  team,
  workspaceName,
  fields,
  defaultModel,
  defaultProvider,
  groupAxis,
}: {
  session: ChatSession
  character?: Character
  team?: Team
  workspaceName?: string
  fields: readonly ConversationSidebarMetadata[]
  defaultModel?: string
  defaultProvider?: string
  groupAxis: ConversationGroupAxis | null
}): MobileChannelRowMetadataItem[] {
  const values: Record<ConversationSidebarMetadata, string | undefined> = {
    agent: session.kind === "team" ? team?.name : character?.name,
    model: getModelDisplayName(
      session.model ?? character?.model ?? defaultModel ?? ANTHROPIC_DEFAULT_MODEL
    ),
    provider: getProviderDisplayName(
      session.providerOverride ?? character?.providerId ?? defaultProvider ?? "anthropic"
    ),
    workspace: workspaceName,
  }
  return fields.flatMap((kind) => {
    // The section header above already names it.
    if (kind === "workspace" && groupAxis === "workspace") return []
    if (
      kind === "agent" &&
      (groupAxis === "agent" || (groupAxis === "team" && session.kind === "team"))
    ) {
      return []
    }
    const value = values[kind]
    return value ? [{ kind, value }] : []
  })
}

function MobileChannelRowImpl({
  session,
  active,
  unread,
  contentMatch,
  character,
  team,
  workspaceName,
  settings,
  renaming,
  actionsHintId,
  onSelect,
  onOpenActions,
  onSwipeAction,
  onCommitRename,
  onCancelRename,
  now,
}: MobileChannelRowProps) {
  const t = useTranslations("mobile.home")
  // Row vocabulary shared with the desktop sidebar.
  const tRow = useTranslations("desktop.sessionRow")
  const tCommon = useTranslations("common")
  // Locale-aware compact timestamps, the desktop row's format, judged in the
  // zone the formatter prints in — "today" in one zone and the clock face in
  // another is how a 14:32 message read as yesterday. `useNow()` without an
  // interval is a stable read (the mount time), only the fallback when the
  // list does not pass its day clock.
  const format = useFormatter()
  const timeZone = useTimeZone()
  const mountNow = useNow()
  const nowMs = now ?? mountNow.getTime()

  const archived = session.archivedAt != null
  const locked = session.handoffLock != null
  const displayTitle = session.title || tRow("untitled")
  const compact = settings.density === "compact"

  const leftActions = useMemo<SwipeAction[]>(() => {
    // A conversation handed off to another device is read-only; its writes
    // are refused, so none are offered as a gesture. The action sheet still
    // opens and says why.
    if (locked) return []
    return [
      {
        id: "pin",
        label: session.pinned ? t("swipeUnpin") : t("swipePin"),
        icon: session.pinned ? <PinOffIcon className="size-4" /> : <PinIcon className="size-4" />,
        onSelect: () => onSwipeAction(session.id, "pin"),
      },
    ]
  }, [locked, session.pinned, session.id, t, onSwipeAction])

  const rightActions = useMemo<SwipeAction[]>(() => {
    const more: SwipeAction = {
      id: "more",
      label: tCommon("more"),
      icon: <MoreHorizontalIcon className="size-4" />,
      onSelect: () => onSwipeAction(session.id, "more"),
    }
    if (locked) return [more]
    return [
      more,
      {
        id: "archive",
        label: archived ? t("swipeUnarchive") : t("swipeArchive"),
        icon: archived ? (
          <ArchiveRestoreIcon className="size-4" />
        ) : (
          <ArchiveIcon className="size-4" />
        ),
        onSelect: () => onSwipeAction(session.id, "archive"),
      },
      {
        id: "delete",
        label: t("swipeDelete"),
        icon: <Trash2Icon className="size-4" />,
        destructive: true,
        onSelect: () => onSwipeAction(session.id, "delete"),
      },
    ]
  }, [locked, archived, session.id, t, tCommon, onSwipeAction])

  const metadata = useMemo(
    () =>
      resolveMobileRowMetadata({
        session,
        character,
        team,
        workspaceName,
        fields: settings.metadataFields,
        defaultModel: settings.defaultModel,
        defaultProvider: settings.defaultProvider,
        groupAxis: settings.groupAxis,
      }),
    [session, character, team, workspaceName, settings]
  )

  if (renaming) {
    return (
      <MobileChannelRenameField
        sessionId={session.id}
        initialTitle={session.title}
        label={t("renameAria")}
        compact={compact}
        onCommit={onCommitRename}
        onCancel={onCancelRename}
      />
    )
  }

  const timestampAt = settings.showTimestamps
    ? (session.lastMessageAt ?? session.updatedAt ?? null)
    : null
  const preview = settings.showPreview ? session.lastMessagePreview : undefined

  return (
    <SwipeRow
      leftActions={leftActions}
      rightActions={rightActions}
      actionWidth={MOBILE_CHANNEL_SWIPE_ACTION_WIDTH}
    >
      <LongPress onLongPress={() => onOpenActions(session.id)} className="block">
        <button
          type="button"
          onClick={() => onSelect(session.id)}
          // Right-click, Shift+F10 and the context-menu key all land here: the
          // keyboard and mouse way to the same sheet a long-press opens.
          onContextMenu={(e) => {
            e.preventDefault()
            onOpenActions(session.id)
          }}
          aria-current={active ? "true" : undefined}
          aria-describedby={actionsHintId}
          data-testid={`mobile-channel-row-${session.id}`}
          data-active={active ? "true" : "false"}
          className={cn(
            // `select-none` + no touch callout: a held finger is a long-press,
            // not a request to select the title or preview the link.
            "relative flex w-full min-w-0 items-center gap-3 px-3 text-left outline-none select-none [-webkit-touch-callout:none]",
            "transition-colors active:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
            compact ? "min-h-11 py-1.5" : "min-h-14 py-2",
            active ? "bg-accent" : "pointer-fine:hover:bg-accent/60"
          )}
        >
          {active ? (
            <span
              aria-hidden
              data-testid="mobile-channel-row-active-bar"
              className="pointer-events-none absolute top-1/2 left-0 h-6 w-0.5 -translate-y-1/2 rounded-r-full bg-primary"
            />
          ) : null}
          <RowAvatar
            session={session}
            character={character}
            team={team}
            showCustomIcons={settings.showCustomIcons}
            displayTitle={displayTitle}
            compact={compact}
          />
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            {/* Title line: the title stretches and ellipsizes; status marks,
                time and the unread badge pin to the trailing edge. */}
            <span className="flex min-w-0 items-center gap-1.5">
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-sm",
                  unread > 0 || active ? "font-semibold" : "font-medium"
                )}
              >
                {displayTitle}
              </span>
              {session.pinned ? (
                <PinIcon
                  role="img"
                  className="size-3 shrink-0 text-muted-foreground"
                  aria-label={tRow("pinned")}
                />
              ) : null}
              {locked ? (
                <LockKeyholeIcon
                  role="img"
                  className="size-3 shrink-0 text-amber-600"
                  aria-label={tRow("handoffReadonly")}
                  data-testid={`mobile-channel-locked-${session.id}`}
                />
              ) : null}
              {timestampAt != null ? (
                <time
                  dateTime={new Date(timestampAt).toISOString()}
                  className="shrink-0 text-[11px] leading-4 text-muted-foreground tabular-nums"
                  data-testid={`mobile-channel-time-${session.id}`}
                >
                  {format.dateTime(
                    new Date(timestampAt),
                    CONVERSATION_TIMESTAMP_FORMATS[
                      conversationTimestampShape(nowMs, timestampAt, timeZone)
                    ]
                  )}
                </time>
              ) : null}
              {unread > 0 ? (
                <span
                  className="flex h-4 min-w-4 shrink-0 items-center justify-center rounded-pill bg-primary px-1 text-[10px] leading-none font-semibold text-primary-foreground tabular-nums"
                  data-testid={`mobile-channel-unread-${session.id}`}
                >
                  <span aria-hidden="true">{unread > 99 ? "99+" : unread}</span>
                  <span className="sr-only">{t("unreadCount", { count: unread })}</span>
                </span>
              ) : null}
            </span>
            {contentMatch ? (
              <span
                className="flex min-w-0 items-center gap-1 text-[11px] leading-4 text-muted-foreground"
                data-testid={`mobile-channel-content-match-${session.id}`}
              >
                <MessageSquareTextIcon className="size-3 shrink-0" aria-hidden />
                <span className="truncate">{tRow("contentMatch")}</span>
              </span>
            ) : null}
            {metadata.length > 0 ? (
              <span
                className="flex min-w-0 items-center gap-1.5 overflow-hidden text-[11px] leading-4 whitespace-nowrap text-muted-foreground"
                data-testid={`mobile-channel-metadata-${session.id}`}
              >
                {metadata.map((item, index) => {
                  const Icon = METADATA_ICON[item.kind]
                  return (
                    <span
                      key={item.kind}
                      className={cn(
                        // The last field is the one that gives up width, so a
                        // long model name ellipsizes instead of clipping.
                        "flex items-center gap-1",
                        index === metadata.length - 1 ? "min-w-0" : "shrink-0",
                        index > 0 && "before:mr-0.5 before:content-['·']"
                      )}
                      data-metadata-kind={item.kind}
                    >
                      <Icon className="size-3 shrink-0" aria-hidden />
                      <span className="truncate">{item.value}</span>
                    </span>
                  )
                })}
              </span>
            ) : null}
            {preview ? (
              <span
                className="truncate text-xs leading-4 text-muted-foreground"
                data-testid={`mobile-channel-subtitle-${session.id}`}
              >
                {preview}
              </span>
            ) : null}
          </span>
        </button>
      </LongPress>
    </SwipeRow>
  )
}

export const MobileChannelRow = memo(MobileChannelRowImpl)
MobileChannelRow.displayName = "MobileChannelRow"

function RowAvatar({
  session,
  character,
  team,
  showCustomIcons,
  displayTitle,
  compact,
}: {
  session: ChatSession
  character?: Character
  team?: Team
  showCustomIcons: boolean
  displayTitle: string
  compact: boolean
}) {
  const size = compact ? "size-8" : "size-10"
  const custom: AvatarSubject | undefined = !showCustomIcons
    ? undefined
    : session.kind === "team"
      ? team
      : character
        ? {
            name: character.name,
            avatarColor: character.avatarColor,
            avatarEmoji: character.avatarEmoji,
            avatarImageUrl: character.avatarImage?.webDataUrl,
          }
        : undefined
  const binding = session.platformBinding

  let face: React.ReactNode
  if (custom) {
    face = (
      <Avatar className={size}>
        {custom.avatarImageUrl ? (
          <AvatarImage src={custom.avatarImageUrl} alt="" className="object-cover" />
        ) : null}
        <AvatarFallback
          style={{ backgroundColor: avatarColor(custom) }}
          className="text-xs text-white"
        >
          {avatarGlyph(custom)}
        </AvatarFallback>
      </Avatar>
    )
  } else if (!showCustomIcons) {
    // Custom icons off: the conversation's kind, like the desktop row.
    const KindIcon =
      session.kind === "team" ? UsersIcon : session.characterId ? HashIcon : MessageSquareIcon
    face = (
      <span
        className={cn(
          "flex shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground",
          size
        )}
      >
        <KindIcon className="size-4" />
      </span>
    )
  } else {
    // No agent or team to show: initials from the title, on a colour seeded
    // by it, so the same conversation keeps the same face.
    face = (
      <Avatar className={size}>
        <AvatarFallback
          style={{ backgroundColor: avatarColor({ name: session.title || displayTitle }) }}
          className="text-xs text-white"
        >
          {avatarGlyph({ name: displayTitle })}
        </AvatarFallback>
      </Avatar>
    )
  }

  return (
    // Decorative: the title names the row.
    <span className="relative shrink-0" aria-hidden="true">
      {face}
      {binding ? (
        <PlatformBadge
          platform={binding.platform}
          iconOnly
          className="absolute -end-1 -bottom-1 rounded-full bg-background p-0.5 [&_svg]:size-3"
        />
      ) : null}
    </span>
  )
}

function MobileChannelRenameField({
  sessionId,
  initialTitle,
  label,
  compact,
  onCommit,
  onCancel,
}: {
  sessionId: string
  initialTitle: string
  label: string
  compact: boolean
  onCommit: (id: string, title: string) => void
  onCancel: (id: string) => void
}) {
  const [draft, setDraft] = useState(initialTitle)
  const inputRef = useRef<HTMLInputElement>(null)
  // Enter commits and then the blur that follows would commit again.
  const settledRef = useRef(false)

  useEffect(() => {
    const input = inputRef.current
    if (!input) return
    input.focus({ preventScroll: true })
    input.select()
  }, [])

  const commit = () => {
    if (settledRef.current) return
    settledRef.current = true
    const next = draft.trim()
    if (next && next !== initialTitle) onCommit(sessionId, next)
    else onCancel(sessionId)
  }
  const cancel = () => {
    if (settledRef.current) return
    settledRef.current = true
    onCancel(sessionId)
  }

  return (
    <div className={cn("flex items-center px-3", compact ? "min-h-11 py-1" : "min-h-14 py-1.5")}>
      <Input
        ref={inputRef}
        type="text"
        enterKeyHint="done"
        autoComplete="off"
        value={draft}
        aria-label={label}
        data-testid={`mobile-channel-rename-${sessionId}`}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault()
            commit()
          } else if (e.key === "Escape") {
            e.preventDefault()
            // The drawer answers Escape too; this one belongs to the field.
            e.stopPropagation()
            cancel()
          }
        }}
        className="h-11 w-full min-w-0"
      />
    </div>
  )
}
