"use client"

import { useTranslations } from "next-intl"
import { MessagesSquareIcon } from "lucide-react"
import { useSettingsStore } from "@/stores/settings"
import type { ConversationTimelineSettings, UtilityModelConfig } from "@/lib/claude/types"
import { SettingsCard } from "../common/settings-section"
import { ModelOverrideFields, useUtilityProviderOptions } from "../common/model-override-fields"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"

/**
 * Settings → Conversation: configure auto-title generation and the right-edge
 * timeline minimap. Title generation and timeline-label generation each get
 * their own background-model override (provider + model).
 */
export function ConversationSection() {
  const t = useTranslations("settings.conversation")
  const settings = useSettingsStore((s) => s.settings)
  const save = useSettingsStore((s) => s.save)

  const title = settings?.conversationTitle
  const timeline = settings?.conversationTimeline
  const labelSummary = timeline?.labelSummary

  const providers = useUtilityProviderOptions()

  const labels = {
    provider: t("provider"),
    model: t("model"),
    useDefault: t("useDefault"),
  }

  const saveTitle = (patch: Partial<UtilityModelConfig>) =>
    void save({ conversationTitle: { ...title, ...patch } })
  const saveTimeline = (patch: Partial<ConversationTimelineSettings>) =>
    void save({ conversationTimeline: { ...timeline, ...patch } })
  const saveLabel = (patch: Partial<UtilityModelConfig>) =>
    void save({
      conversationTimeline: { ...timeline, labelSummary: { ...labelSummary, ...patch } },
    })

  const titleEnabled = title?.enabled !== false
  const timelineEnabled = timeline?.enabled !== false
  const labelEnabled = !!labelSummary?.enabled

  return (
    <SettingsCard
      icon={<MessagesSquareIcon className="size-5" />}
      title={t("title")}
      description={t("description")}
    >
      <div className="space-y-8">
        {/* Auto-generate titles */}
        <section className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-0.5">
              <Label htmlFor="conv-auto-title">{t("autoTitle.heading")}</Label>
              <p className="text-sm text-muted-foreground">{t("autoTitle.description")}</p>
            </div>
            <Switch
              id="conv-auto-title"
              aria-label={t("autoTitle.label")}
              checked={titleEnabled}
              onCheckedChange={(v) => saveTitle({ enabled: v })}
            />
          </div>
          {titleEnabled && (
            <div className="space-y-2 rounded-md border p-3">
              <div className="space-y-0.5">
                <p className="text-sm font-medium">{t("titleModel.heading")}</p>
                <p className="text-xs text-muted-foreground">{t("titleModel.description")}</p>
              </div>
              <ModelOverrideFields
                value={title}
                providers={providers}
                onChange={saveTitle}
                labels={labels}
              />
            </div>
          )}
        </section>

        {/* Conversation timeline minimap */}
        <section className="space-y-4">
          <div className="flex items-center justify-between gap-4">
            <div className="space-y-0.5">
              <Label htmlFor="conv-timeline">{t("timeline.heading")}</Label>
              <p className="text-sm text-muted-foreground">{t("timeline.description")}</p>
            </div>
            <Switch
              id="conv-timeline"
              aria-label={t("timeline.label")}
              checked={timelineEnabled}
              onCheckedChange={(v) => saveTimeline({ enabled: v })}
            />
          </div>

          {timelineEnabled && (
            <>
              <div className="flex items-center justify-between gap-4">
                <div className="space-y-0.5">
                  <Label htmlFor="conv-label-summary">{t("labelSummary.heading")}</Label>
                  <p className="text-sm text-muted-foreground">{t("labelSummary.description")}</p>
                </div>
                <Switch
                  id="conv-label-summary"
                  aria-label={t("labelSummary.label")}
                  checked={labelEnabled}
                  onCheckedChange={(v) => saveLabel({ enabled: v })}
                />
              </div>
              {labelEnabled && (
                <div className="space-y-2 rounded-md border p-3">
                  <div className="space-y-0.5">
                    <p className="text-sm font-medium">{t("labelModel.heading")}</p>
                    <p className="text-xs text-muted-foreground">{t("labelModel.description")}</p>
                  </div>
                  <ModelOverrideFields
                    value={labelSummary}
                    providers={providers}
                    onChange={saveLabel}
                    labels={labels}
                  />
                </div>
              )}
            </>
          )}
        </section>
      </div>
    </SettingsCard>
  )
}
