"use client"

import { useTranslations } from "next-intl"
import { PanelLeftIcon } from "lucide-react"

import { useSettingsStore } from "@/stores/settings"
import { useUIStore, SIDEBAR_WIDTH_DEFAULT } from "@/stores/ui"
import type { ConversationSidebarSettings } from "@cognia/agent-config-types"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { SettingsCard } from "../common/settings-section"

/**
 * Settings → Conversation → "Conversation sidebar": behavior toggles for the
 * chat page's ChannelList. Behavior prefs persist to `AppSettings` via the
 * settings store; the "reset width" action writes the layout width in the UI
 * store (localStorage) since that's where the draggable width lives.
 */
export function ConversationSidebarCard() {
  const t = useTranslations("settings.conversation.sidebar")
  const settings = useSettingsStore((s) => s.settings?.conversationSidebar)
  const save = useSettingsStore((s) => s.save)
  const setSidebarWidth = useUIStore((s) => s.setSidebarWidth)

  const saveSidebar = (patch: Partial<ConversationSidebarSettings>) =>
    void save({ conversationSidebar: { ...settings, ...patch } })

  const compact = settings?.density === "compact"
  const showPreview = settings?.showPreview ?? false
  const groupByDate = settings?.groupByDate !== false
  const showUnreadBadges = settings?.showUnreadBadges !== false
  const contentSearch = settings?.searchScope === "titleAndContent"

  const rows: Array<{
    id: string
    heading: string
    description: string
    label: string
    checked: boolean
    onCheckedChange: (v: boolean) => void
  }> = [
    {
      id: "sidebar-density",
      heading: t("density.heading"),
      description: t("density.description"),
      label: t("density.label"),
      checked: compact,
      onCheckedChange: (v) => saveSidebar({ density: v ? "compact" : "comfortable" }),
    },
    {
      id: "sidebar-preview",
      heading: t("preview.heading"),
      description: t("preview.description"),
      label: t("preview.label"),
      checked: showPreview,
      onCheckedChange: (v) => saveSidebar({ showPreview: v }),
    },
    {
      id: "sidebar-group-by-date",
      heading: t("groupByDate.heading"),
      description: t("groupByDate.description"),
      label: t("groupByDate.label"),
      checked: groupByDate,
      onCheckedChange: (v) => saveSidebar({ groupByDate: v }),
    },
    {
      id: "sidebar-unread",
      heading: t("unread.heading"),
      description: t("unread.description"),
      label: t("unread.label"),
      checked: showUnreadBadges,
      onCheckedChange: (v) => saveSidebar({ showUnreadBadges: v }),
    },
    {
      id: "sidebar-content-search",
      heading: t("contentSearch.heading"),
      description: t("contentSearch.description"),
      label: t("contentSearch.label"),
      checked: contentSearch,
      onCheckedChange: (v) => saveSidebar({ searchScope: v ? "titleAndContent" : "title" }),
    },
  ]

  return (
    <SettingsCard
      icon={<PanelLeftIcon className="size-5" />}
      title={t("title")}
      description={t("description")}
    >
      <div className="space-y-6">
        {rows.map((row) => (
          <div key={row.id} className="flex items-center justify-between gap-4">
            <div className="space-y-0.5">
              <Label htmlFor={row.id}>{row.heading}</Label>
              <p className="text-sm text-muted-foreground">{row.description}</p>
            </div>
            <Switch
              id={row.id}
              aria-label={row.label}
              checked={row.checked}
              onCheckedChange={row.onCheckedChange}
            />
          </div>
        ))}

        <div className="flex items-center justify-between gap-4">
          <div className="space-y-0.5">
            <Label>{t("resetWidth.heading")}</Label>
            <p className="text-sm text-muted-foreground">{t("resetWidth.description")}</p>
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setSidebarWidth(SIDEBAR_WIDTH_DEFAULT)}
          >
            {t("resetWidth.button")}
          </Button>
        </div>
      </div>
    </SettingsCard>
  )
}
