"use client"

/**
 * Inbox sidebar.
 *
 * Header: the list-grouping toggle (status / adapter / platform). It used to
 * write `?view=` and nothing read it; it now drives the list's sections
 * through `useInboxUrlState` (the shell passes `grouping` and the setter).
 *
 * Nav: "All conversations" and "Drafts" (destinations, with an active state),
 * then the scopes. In platform grouping the scopes are platforms, each linking
 * to `/inbox/platform?kind=` — that route had no inbound link before. In
 * status and adapter grouping they are the enabled adapters, each a
 * collapsible section of its recent conversations.
 *
 * `InboxSidebar` renders the full shadcn `<Sidebar>` wrapper (used by the
 * tablet/mobile branch of `<InboxShell />`). `InboxSidebarContent` exposes
 * the inner content only — header + nav — so the desktop branch can mount it
 * inside a `<ResizablePanel>` without doubling the offcanvas positioning Radix
 * applies to `<Sidebar>`.
 */

import Link from "next/link"
import { useRouter } from "next/navigation"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import {
  CircleIcon,
  ChevronRightIcon,
  InboxIcon,
  FileTextIcon,
  LayersIcon,
  ListIcon,
  PlugIcon,
} from "lucide-react"
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarHeader,
} from "@/components/ui/sidebar"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { usePendingDrafts } from "@/hooks/connectors/use-pending-drafts"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { getDb } from "@/lib/db/schema"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import type { ChatSession } from "@cognia/agent-config-types"
import { useMemo, useState, type ReactNode } from "react"
import { PluginExtensionSlot } from "@/components/plugins/plugin-extension-slot"
import { inboxScopeHref, inboxSessionHref } from "@/lib/inbox/conversation-href"
import {
  GROUPING_TO_LEGACY_VIEW,
  INBOX_GROUPINGS,
  isInboxGrouping,
  type InboxGrouping,
} from "@/lib/inbox/inbox-url-state"
import type { PlatformKind } from "@/types/connectors/platform-kind"
import { PlatformBadge } from "./platform-badge"
import { StateCard } from "./state/state-card"

const RECENT_LIMIT = 8

/** Which Inbox route is showing; drives the nav's active state. */
export type InboxView = "all" | "by-adapter" | "by-platform" | "drafts"

/**
 * Icons carry the grouping instead of text. At `INBOX_LAYOUT_BOUNDS.sidebarMin`
 * (12%) the rail is ~123px on a 1024px window, which left each of the three
 * labels ~34px — truncated to unreadable stubs. The labels survive as
 * `aria-label` + tooltip.
 */
const GROUPING_ICON: Record<InboxGrouping, ReactNode> = {
  status: <InboxIcon className="size-3.5" aria-hidden />,
  adapter: <PlugIcon className="size-3.5" aria-hidden />,
  platform: <LayersIcon className="size-3.5" aria-hidden />,
}

export interface InboxSidebarProps {
  view: InboxView
  grouping: InboxGrouping
  onGroupingChange: (grouping: InboxGrouping) => void
  /** Enabled adapters; `undefined` while loading (skeleton, not the empty state). */
  adapters: AdapterInstanceRow[] | undefined
  /** A failed adapters read, captured upstream; shown in place of the scope list. */
  adaptersError?: Error | null
  onRetryAdapters?: () => void
  activeAdapterId?: string
  activePlatformKind?: string
}

/**
 * Tablet / mobile entry-point — wraps the content in the shadcn `<Sidebar>`
 * primitive so the offcanvas-on-mobile behavior of `SidebarProvider` keeps
 * working. The desktop branch of `<InboxShell />` uses
 * `<InboxSidebarContent />` directly inside a `<ResizablePanel>`.
 */
export function InboxSidebar(props: InboxSidebarProps) {
  return (
    <Sidebar>
      <InboxSidebarContent {...props} />
    </Sidebar>
  )
}

/** Platforms of the enabled adapters, first-seen order, deduplicated. */
export function platformsOfAdapters(adapters: readonly AdapterInstanceRow[]): PlatformKind[] {
  const out: PlatformKind[] = []
  for (const adapter of adapters) {
    if (!out.includes(adapter.type)) out.push(adapter.type)
  }
  return out
}

export function InboxSidebarContent({
  view,
  grouping,
  onGroupingChange,
  adapters,
  adaptersError,
  onRetryAdapters,
  activeAdapterId,
  activePlatformKind,
}: InboxSidebarProps) {
  const t = useTranslations("inbox.sidebar")
  const tDraft = useTranslations("inbox.draftCenter")
  const tPlatform = useTranslations("inbox.platformBadge")
  const draftCount = usePendingDrafts().length
  const platforms = useMemo(() => platformsOfAdapters(adapters ?? []), [adapters])
  const platformName = (kind: string) =>
    tPlatform.has(`names.${kind}`) ? tPlatform(`names.${kind}`) : kind

  return (
    <>
      {/* One 48px row with a `border-b`, so the rail shares the seam the list
          and detail panes already have. */}
      <SidebarHeader className="@container/inbox-rail h-[var(--chrome-h)] shrink-0 flex-row items-center gap-1 border-b px-2 py-0 md:px-3">
        <h2 className="me-auto hidden truncate text-sm font-semibold @[13rem]/inbox-rail:block">
          {t("title")}
        </h2>
        <ToggleGroup
          type="single"
          value={grouping}
          onValueChange={(value) => {
            // Radix reports "" when the active item is clicked again; a
            // grouping is always in force, so that is not a change.
            if (isInboxGrouping(value)) onGroupingChange(value)
          }}
          variant="outline"
          size="sm"
          aria-label={t("groupModeAria")}
          className="ms-auto shrink-0"
        >
          {INBOX_GROUPINGS.map((mode) => (
            <Tooltip key={mode}>
              <TooltipTrigger asChild>
                <ToggleGroupItem
                  value={mode}
                  aria-label={t(`groupModes.${mode}`)}
                  data-testid={`group-chip-${mode}`}
                  className="size-7 px-0"
                >
                  {GROUPING_ICON[mode]}
                </ToggleGroupItem>
              </TooltipTrigger>
              <TooltipContent side="bottom">{t(`groupModes.${mode}`)}</TooltipContent>
            </Tooltip>
          ))}
        </ToggleGroup>
      </SidebarHeader>

      <SidebarContent>
        {/* Destinations, not view state, so they belong in the nav (Gmail's
            placement), with the sidebar primitives' active treatment. */}
        <SidebarGroup className="pb-0">
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton asChild isActive={view === "all"} data-testid="inbox-all-link">
                <Link href="/inbox/all" aria-current={view === "all" ? "page" : undefined}>
                  <ListIcon />
                  <span>{t("allConversations")}</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
            <SidebarMenuItem>
              <SidebarMenuButton
                asChild
                isActive={view === "drafts"}
                data-testid="inbox-drafts-link"
              >
                <Link href="/inbox/drafts" aria-current={view === "drafts" ? "page" : undefined}>
                  <FileTextIcon />
                  <span>{tDraft("sidebarLabel")}</span>
                </Link>
              </SidebarMenuButton>
              {draftCount > 0 && (
                <SidebarMenuBadge data-testid="inbox-drafts-count">{draftCount}</SidebarMenuBadge>
              )}
            </SidebarMenuItem>
          </SidebarMenu>
        </SidebarGroup>

        <SidebarGroup>
          <SidebarGroupLabel>
            {grouping === "platform" ? t("platforms") : t("adapters")}
          </SidebarGroupLabel>
          <SidebarMenu>
            {adaptersError ? (
              <SidebarMenuItem data-testid="inbox-adapters-error">
                <StateCard.Error
                  description={adaptersError.message}
                  onRetry={onRetryAdapters}
                  className="mx-2 my-3"
                />
              </SidebarMenuItem>
            ) : adapters === undefined ? (
              // Loading is not "no adapters": the empty card used to flash here
              // on every open before the first read landed.
              <SidebarMenuItem aria-busy="true" data-testid="inbox-adapters-loading">
                <span className="sr-only" role="status">
                  {t("loadingAdapters")}
                </span>
                {Array.from({ length: 3 }).map((_, index) => (
                  <SidebarMenuSkeleton key={index} showIcon aria-hidden />
                ))}
              </SidebarMenuItem>
            ) : adapters.length === 0 ? (
              <SidebarMenuItem>
                <StateCard.Empty
                  title={t("noAdaptersTitle")}
                  description={t("noAdapters")}
                  className="mx-2 my-3"
                />
              </SidebarMenuItem>
            ) : grouping === "platform" ? (
              platforms.map((kind) => {
                const active = view === "by-platform" && activePlatformKind === kind
                return (
                  <SidebarMenuItem key={kind}>
                    <SidebarMenuButton
                      asChild
                      isActive={active}
                      data-testid={`platform-section-${kind}`}
                    >
                      <Link
                        href={inboxScopeHref({ kind: "platform", platform: kind })}
                        aria-current={active ? "page" : undefined}
                      >
                        {/* Decorative beside the name; hidden so the link is
                            not announced as "Lark Lark". */}
                        <span aria-hidden className="contents">
                          <PlatformBadge platform={kind} iconOnly />
                        </span>
                        <span className="truncate">{platformName(kind)}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                )
              })
            ) : (
              adapters.map((adapter) => (
                <AdapterSection
                  key={adapter.id}
                  adapter={adapter}
                  isActive={view === "by-adapter" && activeAdapterId === adapter.id}
                />
              ))
            )}
          </SidebarMenu>
        </SidebarGroup>
        {/* Plugin contributions: custom inbox sidebar groups (e.g. "Pinned",
         * "Starred", "Snoozed"). Hidden when no plugin contributes. `view`
         * keeps its legacy spelling for plugins written against it; `group`
         * is the grouping actually in force. */}
        <PluginExtensionSlot
          point="inbox.sidebar.section"
          className="mt-2 border-t pt-2 empty:hidden"
          context={{
            view: GROUPING_TO_LEGACY_VIEW[grouping],
            group: grouping,
            activeAdapterId,
            activePlatformKind,
          }}
        />
      </SidebarContent>
    </>
  )
}

function AdapterSection({ adapter, isActive }: { adapter: AdapterInstanceRow; isActive: boolean }) {
  const t = useTranslations("inbox.sidebar")
  const [expanded, setExpanded] = useState(false)
  const router = useRouter()

  // Live-query the most recent ChatSession rows bound to this adapter.
  // The query only fires while the section is expanded — collapsed sections
  // don't waste a subscriber.
  const recentSessions = useLiveQuery<ChatSession[]>(() => {
    if (!expanded || typeof window === "undefined") return Promise.resolve([])
    return getDb()
      .sessions.filter((s) => s.platformBinding?.adapterId === adapter.id)
      .toArray()
      .then((rows) =>
        rows.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0)).slice(0, RECENT_LIMIT)
      )
  }, [expanded, adapter.id])

  const toggleExpanded = (e: React.MouseEvent) => {
    e.stopPropagation()
    setExpanded((v) => !v)
  }

  return (
    // The primitives `components/ui/sidebar.tsx` already ships, instead of the
    // hand-rolled equivalents: the old `<div className="flex items-center">`
    // wrapper defeated `SidebarMenuItem`'s `group/menu-item relative` design,
    // and a 36px chevron Button stole width from a rail that bottoms out at
    // ~123px. `SidebarMenuAction` is `w-5` but carries `after:-inset-2
    // md:after:hidden`, so the touch target stays 36px on a phone.
    <SidebarMenuItem>
      <SidebarMenuButton
        onClick={() => router.push(inboxScopeHref({ kind: "adapter", adapterId: adapter.id }))}
        aria-current={isActive ? "page" : undefined}
        isActive={isActive}
        className="pe-8"
        data-testid={`adapter-section-${adapter.id}`}
      >
        {/* Status dot */}
        <CircleIcon
          className={cn(
            "size-2 shrink-0 fill-current",
            adapter.enabled ? "text-emerald-500" : "text-muted-foreground"
          )}
        />
        <span className="truncate">{adapter.displayName}</span>
      </SidebarMenuButton>
      <Tooltip>
        <TooltipTrigger asChild>
          <SidebarMenuAction
            onClick={toggleExpanded}
            aria-expanded={expanded}
            aria-label={t("toggleAdapter", { name: adapter.displayName })}
            data-testid={`adapter-section-toggle-${adapter.id}`}
          >
            {/* One rotating chevron rather than two icons. */}
            <ChevronRightIcon className={cn("transition-transform", expanded && "rotate-90")} />
          </SidebarMenuAction>
        </TooltipTrigger>
        <TooltipContent side="right">{t("expandTooltip")}</TooltipContent>
      </Tooltip>
      {expanded && (
        // `SidebarMenuSub` brings the `border-l` indent guide that a bare
        // `ml-6` never drew.
        <SidebarMenuSub data-testid={`adapter-section-recent-${adapter.id}`}>
          {!recentSessions || recentSessions.length === 0 ? (
            <li className="px-2 py-1 text-[11px] text-muted-foreground">{t("recentEmpty")}</li>
          ) : (
            recentSessions.map((session) => {
              const ck = session.platformBinding!.conversationKey
              return (
                <SidebarMenuSubItem key={session.id}>
                  {/* Touch target stays 44px; md+ takes the primitive's 28px. */}
                  <SidebarMenuSubButton asChild size="sm" className="min-h-11 md:h-7 md:min-h-0">
                    {/* A quick jump into the full chat for this exact session
                        (several sessions can share one conversation key). */}
                    <Link
                      href={inboxSessionHref(ck, session.id)}
                      data-testid={`adapter-recent-${adapter.id}-${session.id}`}
                    >
                      <span className="truncate">{session.title || ck}</span>
                    </Link>
                  </SidebarMenuSubButton>
                </SidebarMenuSubItem>
              )
            })
          )}
        </SidebarMenuSub>
      )}
    </SidebarMenuItem>
  )
}
