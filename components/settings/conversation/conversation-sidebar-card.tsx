"use client"

import { useTranslations } from "next-intl"
import { PanelLeftIcon } from "lucide-react"

import { useSettingsStore } from "@/stores/settings"
import { useUIStore, SIDEBAR_WIDTH_DEFAULT } from "@/stores/ui"
import type {
  ConversationSidebarMetadata,
  ConversationSidebarSettings,
} from "@cognia/agent-config-types"
import { Button } from "@/components/ui/button"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import {
  CONVERSATION_SIDEBAR_METADATA_OPTIONS,
  resolveConversationSidebarMetadata,
  toggleConversationSidebarMetadata,
} from "@/lib/chat/conversation-grouping"
import { SettingsCard } from "../common/settings-section"

/**
 * Settings → Conversation → "Conversation sidebar": how a conversation row
 * *looks* — density, preview line, icons, timestamps, unread badges, and which
 * metadata fields ride under the title.
 *
 * Deliberately not what the list *contains*. Grouping, sort and the search
 * reach used to sit here as three more rows; they live in the list's own
 * toolbar now, beside the rows they rearrange and inside the saved views that
 * can carry them. A settings page is the wrong place to answer "where did my
 * conversation go".
 *
 * Display prefs persist to `AppSettings` via the settings store; the "reset
 * width" action writes the layout width in the UI store (localStorage) since
 * that's where the draggable width lives.
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
  const showCustomIcons = settings?.showCustomIcons !== false
  const showTimestamps = settings?.showTimestamps !== false
  const showUnreadBadges = settings?.showUnreadBadges !== false
  const metadata = resolveConversationSidebarMetadata(settings)
  const titleMotion = settings?.titleMotion ?? "hover"

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
      // The sidebar's own display menu has always had this; Settings did not,
      // so a user looking for it here could not find it.
      id: "sidebar-custom-icons",
      heading: t("customIcons.heading"),
      description: t("customIcons.description"),
      label: t("customIcons.label"),
      checked: showCustomIcons,
      onCheckedChange: (v) => saveSidebar({ showCustomIcons: v }),
    },
    {
      id: "sidebar-timestamps",
      heading: t("timestamps.heading"),
      description: t("timestamps.description"),
      label: t("timestamps.label"),
      checked: showTimestamps,
      onCheckedChange: (v) => saveSidebar({ showTimestamps: v }),
    },
    {
      id: "sidebar-unread",
      heading: t("unread.heading"),
      description: t("unread.description"),
      label: t("unread.label"),
      checked: showUnreadBadges,
      onCheckedChange: (v) => saveSidebar({ showUnreadBadges: v }),
    },
  ]

  const metadataRows = CONVERSATION_SIDEBAR_METADATA_OPTIONS.map((field) => ({
    id: `sidebar-metadata-${field}`,
    field,
    heading: t(`metadata.${field}.heading`),
    description: t(`metadata.${field}.description`),
    label: t(`metadata.${field}.label`),
    checked: metadata.includes(field),
  }))

  const setMetadata = (field: ConversationSidebarMetadata, enabled: boolean) =>
    saveSidebar({ metadata: toggleConversationSidebarMetadata(metadata, field, enabled) })

  return (
    <SettingsCard
      icon={<PanelLeftIcon className="size-5" />}
      title={t("title")}
      description={t("description")}
    >
      <div className="space-y-6">
        {/* Grouping, sort and the search reach used to live here as three more
            rows. They moved to the list's own toolbar, where the difference
            they make is visible: this card decides how a row *looks*, the
            toolbar decides which rows exist and in what order — and a saved
            view can carry the latter, which a settings page cannot. */}
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

        <div className="space-y-4 border-t pt-5">
          <div className="space-y-0.5">
            <p className="text-sm font-medium">{t("metadata.heading")}</p>
            <p className="text-sm text-muted-foreground">{t("metadata.description")}</p>
          </div>
          {metadataRows.map((row) => (
            <div key={row.id} className="flex items-center justify-between gap-4">
              <div className="space-y-0.5">
                <Label htmlFor={row.id}>{row.heading}</Label>
                <p className="text-sm text-muted-foreground">{row.description}</p>
              </div>
              <Switch
                id={row.id}
                aria-label={row.label}
                checked={row.checked}
                onCheckedChange={(enabled) => setMetadata(row.field, enabled)}
              />
            </div>
          ))}
        </div>

        <div className="flex items-center justify-between gap-4">
          <div className="space-y-0.5">
            <Label htmlFor="sidebar-title-motion">{t("titleMotion.heading")}</Label>
            <p className="text-sm text-muted-foreground">{t("titleMotion.description")}</p>
          </div>
          <Switch
            id="sidebar-title-motion"
            aria-label={t("titleMotion.label")}
            checked={titleMotion === "hover"}
            onCheckedChange={(enabled) => saveSidebar({ titleMotion: enabled ? "hover" : "off" })}
          />
        </div>

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
