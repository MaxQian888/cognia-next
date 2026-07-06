"use client"

/**
 * Mobile Conversation page — two background-experience toggles:
 *   - `conversationTitle.enabled`    auto-generate a chat title from the first turn
 *   - `conversationTimeline.enabled` show the right-edge timeline minimap
 *
 * Both are nested objects (`UtilityModelConfig` / `ConversationTimelineSettings`)
 * and merge-update exactly like `biometricRequiredFor` in the preferences page,
 * preserving sibling keys (`model`, `expanded`, `labelSummary`, …). The parent
 * keys `conversationTitle` / `conversationTimeline` are in the
 * `app_settings_update` allowlist (`companion_api/rpc.rs`).
 */

import { useTranslations } from "next-intl"

import { BiometricRow } from "@/components/mobile/me/biometric-row"
import { MeSection } from "@/components/mobile/me/me-section"
import { SubPageShell } from "@/components/mobile/me/sub-page-shell"
import { useSettingsPatch } from "@/hooks/use-settings-patch"
import type {
  AppSettings,
  ConversationTimelineSettings,
  UtilityModelConfig,
} from "@/lib/claude/types"
import { useSettingsStore } from "@/stores/settings"

type ComposerBehavior = NonNullable<AppSettings["composerBehavior"]>
type ConversationSidebar = NonNullable<AppSettings["conversationSidebar"]>

export default function MobileConversationPage() {
  const t = useTranslations("mobile.conversation")

  const settings = useSettingsStore((s) => s.settings)
  const update = useSettingsPatch()

  const title: UtilityModelConfig = settings?.conversationTitle ?? {}
  const timeline: ConversationTimelineSettings = settings?.conversationTimeline ?? {}
  const composer: ComposerBehavior = settings?.composerBehavior ?? {}

  // `enabled` defaults to true for both subsystems when unset.
  const titleEnabled = title.enabled ?? true
  const timelineEnabled = timeline.enabled ?? true
  // Composer + stream toggles all default ON (an absent value ⇒ historical
  // behavior), so `!== false`.
  const streamPartial = settings?.streamPartialMessages !== false

  const setComposer = (patch: Partial<ComposerBehavior>) =>
    update({ composerBehavior: { ...composer, ...patch } })

  const sidebar: ConversationSidebar = settings?.conversationSidebar ?? {}
  const setSidebar = (patch: Partial<ConversationSidebar>) =>
    update({ conversationSidebar: { ...sidebar, ...patch } })

  return (
    <SubPageShell title={t("title")} backAria={t("backAria")} testid="mobile-conversation-page">
      <div className="flex flex-col gap-4">
        <MeSection
          title={t("sectionTitle")}
          description={t("sectionDescription")}
          testid="me-section-conversation"
        >
          <BiometricRow
            label={t("autoTitle")}
            help={t("autoTitleHelp")}
            checked={titleEnabled}
            onChange={(v) => void update({ conversationTitle: { ...title, enabled: v } })}
            testid="conversation-auto-title"
          />
          <BiometricRow
            label={t("timeline")}
            help={t("timelineHelp")}
            checked={timelineEnabled}
            onChange={(v) => void update({ conversationTimeline: { ...timeline, enabled: v } })}
            testid="conversation-timeline"
          />
        </MeSection>

        <MeSection
          title={t("composerSection")}
          description={t("composerSectionHelp")}
          testid="me-section-conversation-composer"
        >
          <BiometricRow
            label={t("sendOnEnter")}
            help={t("sendOnEnterHelp")}
            checked={composer.sendOnEnter !== false}
            onChange={(v) => void setComposer({ sendOnEnter: v })}
            testid="composer-send-on-enter"
          />
          <BiometricRow
            label={t("clearAfterSend")}
            help={t("clearAfterSendHelp")}
            checked={composer.clearAfterSend !== false}
            onChange={(v) => void setComposer({ clearAfterSend: v })}
            testid="composer-clear-after-send"
          />
          <BiometricRow
            label={t("autoScroll")}
            help={t("autoScrollHelp")}
            checked={composer.autoScrollOnStream !== false}
            onChange={(v) => void setComposer({ autoScrollOnStream: v })}
            testid="composer-auto-scroll"
          />
          <BiometricRow
            label={t("inputHistory")}
            help={t("inputHistoryHelp")}
            checked={composer.inputHistoryRecall !== false}
            onChange={(v) => void setComposer({ inputHistoryRecall: v })}
            testid="composer-input-history"
          />
          <BiometricRow
            label={t("persistDrafts")}
            help={t("persistDraftsHelp")}
            checked={composer.persistDrafts !== false}
            onChange={(v) => void setComposer({ persistDrafts: v })}
            testid="composer-persist-drafts"
          />
        </MeSection>

        <MeSection
          title={t("streamSection")}
          description={t("streamSectionHelp")}
          testid="me-section-conversation-stream"
        >
          <BiometricRow
            label={t("streamPartial")}
            help={t("streamPartialHelp")}
            checked={streamPartial}
            onChange={(v) => void update({ streamPartialMessages: v })}
            testid="conversation-stream-partial"
          />
        </MeSection>

        <MeSection
          title={t("sidebarSection")}
          description={t("sidebarSectionHelp")}
          testid="me-section-conversation-sidebar"
        >
          <BiometricRow
            label={t("sidebarCompact")}
            help={t("sidebarCompactHelp")}
            checked={sidebar.density === "compact"}
            onChange={(v) => void setSidebar({ density: v ? "compact" : "comfortable" })}
            testid="conversation-sidebar-compact"
          />
          <BiometricRow
            label={t("sidebarPreview")}
            help={t("sidebarPreviewHelp")}
            checked={sidebar.showPreview === true}
            onChange={(v) => void setSidebar({ showPreview: v })}
            testid="conversation-sidebar-preview"
          />
          <BiometricRow
            label={t("sidebarGroupByDate")}
            help={t("sidebarGroupByDateHelp")}
            checked={sidebar.groupByDate !== false}
            onChange={(v) => void setSidebar({ groupByDate: v })}
            testid="conversation-sidebar-group-by-date"
          />
          <BiometricRow
            label={t("sidebarUnread")}
            help={t("sidebarUnreadHelp")}
            checked={sidebar.showUnreadBadges !== false}
            onChange={(v) => void setSidebar({ showUnreadBadges: v })}
            testid="conversation-sidebar-unread"
          />
          <BiometricRow
            label={t("sidebarContentSearch")}
            help={t("sidebarContentSearchHelp")}
            checked={sidebar.searchScope === "titleAndContent"}
            onChange={(v) => void setSidebar({ searchScope: v ? "titleAndContent" : "title" })}
            testid="conversation-sidebar-content-search"
          />
        </MeSection>
      </div>
    </SubPageShell>
  )
}
