"use client"

import { useMemo } from "react"
import { useTranslations } from "next-intl"
import { MessagesSquareIcon } from "lucide-react"
import { useSettingsStore } from "@/stores/settings"
import type { ConversationTimelineSettings, UtilityModelConfig } from "@/lib/claude/types"
import { SettingsCard } from "../common/settings-section"
import { Label } from "@/components/ui/label"
import { Switch } from "@/components/ui/switch"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"

const DEFAULT_PROVIDER_VALUE = "__default__"

interface ProviderOption {
  id: string
  name: string
}

/**
 * Provider + model override fields for a background "utility model" config.
 * Provider is a select of the user's configured providers (or "use chat
 * default"); model is free text since model ids vary per provider.
 */
function ModelOverrideFields({
  value,
  providers,
  onChange,
  labels,
}: {
  value: UtilityModelConfig | undefined
  providers: ProviderOption[]
  onChange: (patch: Partial<UtilityModelConfig>) => void
  labels: { provider: string; model: string; useDefault: string }
}) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <div className="space-y-1.5">
        <Label>{labels.provider}</Label>
        <Select
          value={value?.providerOverride || DEFAULT_PROVIDER_VALUE}
          onValueChange={(v) =>
            onChange({ providerOverride: v === DEFAULT_PROVIDER_VALUE ? undefined : v })
          }
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={DEFAULT_PROVIDER_VALUE}>{labels.useDefault}</SelectItem>
            {providers.map((p) => (
              <SelectItem key={p.id} value={p.id}>
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="space-y-1.5">
        <Label>{labels.model}</Label>
        <Input
          value={value?.model ?? ""}
          placeholder={labels.useDefault}
          onChange={(e) => onChange({ model: e.target.value || undefined })}
        />
      </div>
    </div>
  )
}

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

  const providers = useMemo<ProviderOption[]>(() => {
    const map = new Map<string, ProviderOption>()
    for (const id of Object.keys(settings?.providerSettings ?? {})) {
      map.set(id, { id, name: id })
    }
    for (const p of settings?.customProviders ?? []) {
      const cp = p as { id: string; name?: string }
      map.set(cp.id, { id: cp.id, name: cp.name ?? cp.id })
    }
    return [...map.values()]
  }, [settings?.providerSettings, settings?.customProviders])

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
