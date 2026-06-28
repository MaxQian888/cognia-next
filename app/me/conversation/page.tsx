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
import { enqueue } from "@/lib/db/mobile-outbound-queue"
import type {
  AppSettings,
  ConversationTimelineSettings,
  UtilityModelConfig,
} from "@/lib/claude/types"
import { useSettingsStore } from "@/stores/settings"

export default function MobileConversationPage() {
  const t = useTranslations("mobile.conversation")
  const tPanel = useTranslations("mobile.settingsPanel")

  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)

  const title: UtilityModelConfig = settings?.conversationTitle ?? {}
  const timeline: ConversationTimelineSettings = settings?.conversationTimeline ?? {}

  // `enabled` defaults to true for both subsystems when unset.
  const titleEnabled = title.enabled ?? true
  const timelineEnabled = timeline.enabled ?? true

  const update = async (patch: Partial<AppSettings>) => {
    await save(patch as never)
    const keys = Object.keys(patch ?? {}).join(", ")
    await enqueue({
      command: "app_settings_update",
      payload: { patch },
      label: tPanel("queueLabel", { keys }),
    })
  }

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
      </div>
    </SubPageShell>
  )
}
