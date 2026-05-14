"use client"

/**
 * Inbox sidebar.
 *
 * Lists each enabled adapter as a collapsible section. Three view-mode chips
 * at the top ("By adapter" / "By platform" / "Unified") update the URL query
 * parameter `?view=...`.
 */

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
import { useState } from "react"

export type InboxViewMode = "by-adapter" | "by-platform" | "unified"

const VIEW_MODE_LABELS: Record<InboxViewMode, string> = {
  "by-adapter": "By adapter",
  "by-platform": "By platform",
  unified: "Unified",
}

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
              {VIEW_MODE_LABELS[mode]}
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
  const [expanded, setExpanded] = useState(false)
  const router = useRouter()

  return (
    <SidebarMenuItem>
      <SidebarMenuButton
        onClick={() => {
          setExpanded((e) => !e)
          router.push(`/inbox/adapter/${adapter.id}`)
        }}
        isActive={isActive}
        className="flex items-center gap-2"
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
        {expanded ? (
          <ChevronDownIcon className="h-3 w-3 shrink-0" />
        ) : (
          <ChevronRightIcon className="h-3 w-3 shrink-0" />
        )}
      </SidebarMenuButton>
    </SidebarMenuItem>
  )
}
