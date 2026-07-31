"use client"

/**
 * Inbox sidebar.
 *
 * Lists each enabled adapter as a collapsible section. Three view-mode chips
 * at the top ("By adapter" / "By platform" / "Unified") update the URL query
 * parameter `?view=...`.
 *
 * `InboxSidebar` renders the full shadcn `<Sidebar>` wrapper (used by the
 * tablet/mobile branch of `<InboxShell />`). `InboxSidebarContent` exposes
 * the inner content only — header + adapter group — so the desktop branch
 * can mount it inside a `<ResizablePanel>` without doubling the offcanvas
 * positioning Radix applies to `<Sidebar>`.
 */

import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import {
  CircleIcon,
  ChevronRightIcon,
  InboxIcon,
  FileTextIcon,
  LayersIcon,
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
import { useState, type ReactNode } from "react"
import { PluginExtensionSlot } from "@/components/plugins/plugin-extension-slot"
import { StateCard } from "./state/state-card"

const RECENT_LIMIT = 8

export type InboxViewMode = "by-adapter" | "by-platform" | "unified"

const ALL_VIEW_MODES: InboxViewMode[] = ["by-adapter", "by-platform", "unified"]

/**
 * Icons carry the view mode instead of text. At `INBOX_LAYOUT_BOUNDS.sidebarMin`
 * (12%) the rail is ~123px on a 1024px window, which left each of the three
 * labels ~34px — truncated to unreadable stubs. The labels survive as
 * `aria-label` + tooltip.
 */
const VIEW_MODE_ICON: Record<InboxViewMode, ReactNode> = {
  "by-adapter": <PlugIcon className="size-3.5" aria-hidden />,
  "by-platform": <LayersIcon className="size-3.5" aria-hidden />,
  unified: <InboxIcon className="size-3.5" aria-hidden />,
}

interface InboxSidebarProps {
  view: string
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

export function InboxSidebarContent({
  view,
  activeAdapterId,
  activePlatformKind,
}: InboxSidebarProps) {
  const t = useTranslations("inbox.sidebar")
  const tDraft = useTranslations("inbox.draftCenter")
  const router = useRouter()
  const searchParams = useSearchParams()
  const draftCount = usePendingDrafts().length

  const currentViewMode: InboxViewMode = ALL_VIEW_MODES.includes(view as InboxViewMode)
    ? (view as InboxViewMode)
    : "by-adapter"

  const adapterInstances = useLiveQuery<AdapterInstanceRow[]>(
    () =>
      typeof window === "undefined"
        ? Promise.resolve([])
        : getDb()
            .adapterInstances.filter((r) => r.enabled)
            .toArray(),
    []
  )

  const switchViewMode = (mode: InboxViewMode) => {
    const next = new URLSearchParams(searchParams.toString())
    next.set("view", mode)
    router.replace(`?${next.toString()}`, { scroll: false })
  }

  return (
    <>
      {/* One 48px row with a `border-b`, so the rail shares the seam the list
          and detail panes already have — this header used to stack a title, a
          full-width 3-up ToggleGroup and the drafts link with no seam at all. */}
      <SidebarHeader className="@container/inbox-rail h-12 shrink-0 flex-row items-center gap-1 border-b px-2 py-0 md:px-3">
        <h2 className="me-auto hidden truncate text-sm font-semibold @[13rem]/inbox-rail:block">
          {t("title")}
        </h2>
        <ToggleGroup
          type="single"
          value={currentViewMode}
          onValueChange={(value) => {
            if (!value) return
            switchViewMode(value as InboxViewMode)
          }}
          variant="outline"
          size="sm"
          aria-label={t("viewModeAria")}
          className="ms-auto shrink-0"
        >
          {ALL_VIEW_MODES.map((mode) => (
            <Tooltip key={mode}>
              <TooltipTrigger asChild>
                <ToggleGroupItem
                  value={mode}
                  aria-label={t(`viewModes.${mode}`)}
                  data-testid={`view-chip-${mode}`}
                  className="size-7 px-0"
                >
                  {VIEW_MODE_ICON[mode]}
                </ToggleGroupItem>
              </TooltipTrigger>
              <TooltipContent side="bottom">{t(`viewModes.${mode}`)}</TooltipContent>
            </Tooltip>
          ))}
        </ToggleGroup>
      </SidebarHeader>

      <SidebarContent>
        {/* Drafts is a destination, not view state, so it belongs in the nav
            rather than the header (Gmail's placement). Using the sidebar
            primitives also gets it the same hover / active / height / type as
            the adapter rows, which its bespoke class string never matched. */}
        <SidebarGroup className="pb-0">
          <SidebarMenu>
            <SidebarMenuItem>
              <SidebarMenuButton asChild data-testid="inbox-drafts-link">
                <Link href="/inbox/drafts">
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
          <SidebarGroupLabel>{t("adapters")}</SidebarGroupLabel>
          <SidebarMenu>
            {!adapterInstances || adapterInstances.length === 0 ? (
              <SidebarMenuItem>
                {/* `StateCard` was built to unify the Inbox's empty/loading
                    treatments; this was one of the three it names. */}
                <StateCard.Empty
                  title={t("noAdaptersTitle")}
                  description={t("noAdapters")}
                  className="mx-2 my-3"
                />
              </SidebarMenuItem>
            ) : (
              adapterInstances.map((adapter) => (
                <AdapterSection
                  key={adapter.id}
                  adapter={adapter}
                  isActive={activeAdapterId === adapter.id}
                  platformKind={activePlatformKind}
                />
              ))
            )}
          </SidebarMenu>
        </SidebarGroup>
        {/* Plugin contributions: custom inbox sidebar groups (e.g. "Pinned",
         * "Starred", "Snoozed"). Hidden when no plugin contributes.
         */}
        <PluginExtensionSlot
          point="inbox.sidebar.section"
          className="mt-2 border-t pt-2 empty:hidden"
          context={{ view: currentViewMode, activeAdapterId, activePlatformKind }}
        />
      </SidebarContent>
    </>
  )
}

function AdapterSection({
  adapter,
  isActive,
}: {
  adapter: AdapterInstanceRow
  isActive: boolean
  platformKind?: string
}) {
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
        onClick={() => router.push(`/inbox/adapter?adapterId=${encodeURIComponent(adapter.id)}`)}
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
                    <Link
                      href={`/inbox/c?key=${encodeURIComponent(ck)}`}
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
