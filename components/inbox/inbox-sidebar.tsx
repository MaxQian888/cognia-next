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
  ChevronDownIcon,
  ChevronRightIcon,
  InboxIcon,
  FileTextIcon,
} from "lucide-react"
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarHeader,
} from "@/components/ui/sidebar"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import { usePendingDrafts } from "@/hooks/connectors/use-pending-drafts"
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription } from "@/components/ui/empty"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { getDb } from "@/lib/db/schema"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import type { ChatSession } from "@/lib/claude/types"
import { useState } from "react"
import { PluginExtensionSlot } from "@/components/plugins/plugin-extension-slot"

const RECENT_LIMIT = 8

export type InboxViewMode = "by-adapter" | "by-platform" | "unified"

const ALL_VIEW_MODES: InboxViewMode[] = ["by-adapter", "by-platform", "unified"]

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
      <SidebarHeader className="px-3 py-2 space-y-2">
        <h2 className="text-sm font-semibold">{t("title")}</h2>
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
          className="w-full"
        >
          {ALL_VIEW_MODES.map((mode) => (
            <ToggleGroupItem
              key={mode}
              value={mode}
              aria-label={t(`viewModes.${mode}`)}
              data-testid={`view-chip-${mode}`}
              className="flex-1 h-7 text-xs"
            >
              {t(`viewModes.${mode}`)}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <Link
          href="/inbox/drafts"
          className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground"
          data-testid="inbox-drafts-link"
        >
          <FileTextIcon className="size-3.5 shrink-0" />
          <span className="flex-1">{tDraft("sidebarLabel")}</span>
          {draftCount > 0 && (
            <Badge
              variant="warning"
              className="h-4 px-1 text-[10px] leading-none"
              data-testid="inbox-drafts-count"
            >
              {draftCount}
            </Badge>
          )}
        </Link>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>{t("adapters")}</SidebarGroupLabel>
          <SidebarMenu>
            {!adapterInstances || adapterInstances.length === 0 ? (
              <SidebarMenuItem>
                <Empty className="border-0 p-4">
                  <EmptyHeader>
                    <EmptyMedia variant="icon">
                      <InboxIcon />
                    </EmptyMedia>
                    <EmptyTitle>{t("noAdaptersTitle")}</EmptyTitle>
                    <EmptyDescription>{t("noAdapters")}</EmptyDescription>
                  </EmptyHeader>
                </Empty>
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
    <SidebarMenuItem>
      <div className="flex items-center">
        <SidebarMenuButton
          onClick={() => router.push(`/inbox/adapter?adapterId=${encodeURIComponent(adapter.id)}`)}
          isActive={isActive}
          className="flex items-center gap-2 flex-1"
          data-testid={`adapter-section-${adapter.id}`}
        >
          {/* Status dot */}
          <CircleIcon
            className={cn(
              "h-2 w-2 fill-current shrink-0",
              adapter.enabled ? "text-emerald-500" : "text-muted-foreground"
            )}
          />
          <span className="flex-1 truncate">{adapter.displayName}</span>
        </SidebarMenuButton>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={toggleExpanded}
              aria-expanded={expanded}
              aria-label={t("toggleAdapter", { name: adapter.displayName })}
              className="h-9 w-9 shrink-0 text-muted-foreground hover:text-foreground md:h-7 md:w-7"
              data-testid={`adapter-section-toggle-${adapter.id}`}
            >
              {expanded ? (
                <ChevronDownIcon className="h-3 w-3" />
              ) : (
                <ChevronRightIcon className="h-3 w-3" />
              )}
            </Button>
          </TooltipTrigger>
          <TooltipContent side="right">{t("expandTooltip")}</TooltipContent>
        </Tooltip>
      </div>
      {expanded && (
        <ul
          className="ml-6 mt-1 mb-1 space-y-0.5"
          data-testid={`adapter-section-recent-${adapter.id}`}
        >
          {!recentSessions || recentSessions.length === 0 ? (
            <li className="px-2 py-1 text-[11px] text-muted-foreground">{t("recentEmpty")}</li>
          ) : (
            recentSessions.map((session) => {
              const ck = session.platformBinding!.conversationKey
              return (
                <li key={session.id}>
                  <Link
                    href={`/inbox/c?key=${encodeURIComponent(ck)}`}
                    className="flex min-h-11 items-center rounded px-2 py-2.5 text-xs text-muted-foreground hover:bg-accent hover:text-foreground md:min-h-0 md:py-1"
                    data-testid={`adapter-recent-${adapter.id}-${session.id}`}
                  >
                    <span className="truncate">{session.title || ck}</span>
                  </Link>
                </li>
              )
            })
          )}
        </ul>
      )}
    </SidebarMenuItem>
  )
}
