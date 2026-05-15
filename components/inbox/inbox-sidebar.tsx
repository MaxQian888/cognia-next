"use client"

/**
 * Inbox sidebar.
 *
 * Lists each enabled adapter as a collapsible section. Three view-mode chips
 * at the top ("By adapter" / "By platform" / "Unified") update the URL query
 * parameter `?view=...`.
 */

import Link from "next/link"
import { useRouter, useSearchParams } from "next/navigation"
import { useTranslations } from "next-intl"
import { useLiveQuery } from "dexie-react-hooks"
import { CircleIcon, ChevronDownIcon, ChevronRightIcon } from "lucide-react"
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

export function InboxSidebar({ view, activeAdapterId, activePlatformKind }: InboxSidebarProps) {
  const t = useTranslations("inbox.sidebar")
  const router = useRouter()
  const searchParams = useSearchParams()

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
    <Sidebar>
      <SidebarHeader className="px-3 py-2 space-y-2">
        <h2 className="text-sm font-semibold">{t("title")}</h2>
        {/* View-mode chips */}
        <div className="flex flex-wrap gap-1" role="group" aria-label={t("viewModeAria")}>
          {ALL_VIEW_MODES.map((mode) => (
            <Button
              key={mode}
              variant={currentViewMode === mode ? "default" : "outline"}
              size="sm"
              className="h-6 px-2 text-xs"
              onClick={() => switchViewMode(mode)}
              data-testid={`view-chip-${mode}`}
            >
              {t(`viewModes.${mode}`)}
            </Button>
          ))}
        </div>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupLabel>{t("adapters")}</SidebarGroupLabel>
          <SidebarMenu>
            {!adapterInstances || adapterInstances.length === 0 ? (
              <SidebarMenuItem>
                <span className="px-3 py-2 text-xs text-muted-foreground">{t("noAdapters")}</span>
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
    </Sidebar>
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
          onClick={() => router.push(`/inbox/adapter/${adapter.id}`)}
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
        <button
          type="button"
          onClick={toggleExpanded}
          aria-expanded={expanded}
          className="flex h-7 w-7 shrink-0 items-center justify-center text-muted-foreground hover:text-foreground"
          data-testid={`adapter-section-toggle-${adapter.id}`}
        >
          {expanded ? (
            <ChevronDownIcon className="h-3 w-3" />
          ) : (
            <ChevronRightIcon className="h-3 w-3" />
          )}
        </button>
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
                    href={`/inbox/c/${encodeURIComponent(ck)}`}
                    className="block truncate rounded px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                    data-testid={`adapter-recent-${adapter.id}-${session.id}`}
                  >
                    {session.title || ck}
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
