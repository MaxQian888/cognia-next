"use client"

import { useCallback, useMemo } from "react"
import { AudioWaveformIcon } from "lucide-react"
import { useTranslations } from "next-intl"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import { useSettingsStore } from "@/stores/settings"
import { DEFAULT_LIVE_VOICE_SETTINGS, type LiveVoiceSettings } from "@cognia/agent-config-types"
import {
  IMPLEMENTED_LIVE_VOICE_PROVIDERS,
  LIVE_VOICE_DEFAULT_MODELS,
  LIVE_VOICE_DEFAULT_VOICES,
  LIVE_VOICE_PROVIDER_DESCRIPTORS,
} from "@/lib/voice/live/adapter-registry"
import { isLiveVoiceProviderEnabled } from "@/lib/voice/live/feature-flags"
import { isTauri } from "@/lib/platform/detect"
import type {
  LiveVoiceDeployment,
  LiveVoiceProviderId,
  LiveVoiceRegion,
} from "@/lib/voice/live/types"
import { ApiKeyInput } from "./api-key-input"

/**
 * One deployment per provider per region, with a derived id.
 *
 * The data model allows several deployments of the same provider, but nothing
 * in the product distinguishes them yet — surfacing a generic add/remove list
 * would be a CRUD screen for a difference the user cannot act on. A stable
 * derived id also means toggling a provider off and on again restores the
 * settings they had rather than orphaning a row.
 */
function deploymentId(provider: LiveVoiceProviderId, region: LiveVoiceRegion): string {
  return `${provider}-${region}`
}

export function LiveVoiceCard() {
  const t = useTranslations("settings.speech.live")
  const settings = useSettingsStore((store) => store.settings)
  const save = useSettingsStore((store) => store.save)

  const liveVoice: LiveVoiceSettings = useMemo(
    () => ({ ...DEFAULT_LIVE_VOICE_SETTINGS, ...(settings?.liveVoice ?? {}) }),
    [settings?.liveVoice]
  )

  const patch = useCallback(
    (changes: Partial<LiveVoiceSettings>) => void save({ liveVoice: { ...liveVoice, ...changes } }),
    [liveVoice, save]
  )

  // Only providers that have an adapter AND pass their rollout switch AND serve
  // the selected region. Anything else would be a control that cannot connect.
  const available = useMemo(
    () =>
      IMPLEMENTED_LIVE_VOICE_PROVIDERS.filter((provider) => {
        const descriptor = LIVE_VOICE_PROVIDER_DESCRIPTORS[provider]
        return (
          isLiveVoiceProviderEnabled(provider) &&
          descriptor.regions.includes(liveVoice.region) &&
          (descriptor.transport === "browser" || isTauri())
        )
      }),
    [liveVoice.region]
  )

  const deploymentFor = useCallback(
    (provider: LiveVoiceProviderId): LiveVoiceDeployment | undefined =>
      liveVoice.deployments.find((item) => item.id === deploymentId(provider, liveVoice.region)),
    [liveVoice.deployments, liveVoice.region]
  )

  const upsertDeployment = useCallback(
    (provider: LiveVoiceProviderId, changes: Partial<LiveVoiceDeployment>) => {
      const id = deploymentId(provider, liveVoice.region)
      const existing = liveVoice.deployments.find((item) => item.id === id)
      const next: LiveVoiceDeployment = {
        id,
        provider,
        region: liveVoice.region,
        enabled: false,
        ...existing,
        ...changes,
      }
      patch({
        deployments: existing
          ? liveVoice.deployments.map((item) => (item.id === id ? next : item))
          : [...liveVoice.deployments, next],
      })
    },
    [liveVoice.deployments, liveVoice.region, patch]
  )

  const enabledDeployments = available.filter((provider) => deploymentFor(provider)?.enabled)

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <AudioWaveformIcon className="size-4 text-primary" />
          {t("title")}
        </CardTitle>
        <CardDescription className="text-xs">{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-1">
            <Label htmlFor="live-voice-enabled">{t("enabled")}</Label>
            <p className="text-xs text-muted-foreground">{t("enabledHint")}</p>
          </div>
          <Switch
            aria-label={t("enabled")}
            checked={liveVoice.enabled}
            id="live-voice-enabled"
            onCheckedChange={(checked) => patch({ enabled: checked })}
          />
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label>{t("region")}</Label>
            <Select
              value={liveVoice.region}
              onValueChange={(value) => patch({ region: value as LiveVoiceRegion })}
            >
              <SelectTrigger aria-label={t("region")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="global">{t("regionGlobal")}</SelectItem>
                {isTauri() && <SelectItem value="cn">{t("regionCn")}</SelectItem>}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{t("regionHint")}</p>
          </div>

          <div className="space-y-2">
            <Label>{t("preferred")}</Label>
            <Select
              disabled={enabledDeployments.length === 0}
              value={liveVoice.preferredDeploymentId ?? ""}
              onValueChange={(value) => patch({ preferredDeploymentId: value })}
            >
              <SelectTrigger aria-label={t("preferred")}>
                <SelectValue placeholder={t("preferredPlaceholder")} />
              </SelectTrigger>
              <SelectContent>
                {enabledDeployments.map((provider) => (
                  <SelectItem key={provider} value={deploymentId(provider, liveVoice.region)}>
                    {t(`providers.${provider}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{t("preferredHint")}</p>
          </div>
        </div>

        <div className="space-y-3">
          <Label>{t("providersTitle")}</Label>
          {available.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("noProviders")}</p>
          ) : (
            available.map((provider) => {
              const deployment = deploymentFor(provider)
              const descriptor = LIVE_VOICE_PROVIDER_DESCRIPTORS[provider]
              return (
                <div className="space-y-3 rounded-lg border p-3" key={provider}>
                  <div className="flex items-center justify-between gap-4">
                    <Label htmlFor={`live-voice-${provider}`}>{t(`providers.${provider}`)}</Label>
                    <Switch
                      aria-label={t(`providers.${provider}`)}
                      checked={deployment?.enabled ?? false}
                      id={`live-voice-${provider}`}
                      onCheckedChange={(checked) =>
                        upsertDeployment(provider, { enabled: checked })
                      }
                    />
                  </div>

                  {deployment?.enabled && (
                    <div className="space-y-3">
                      <ApiKeyInput
                        label={t(`credential.${descriptor.credential.kind}`)}
                        provider={descriptor.credential.keyringId}
                      />
                      {descriptor.fields.includes("workspaceId") && (
                        <div className="space-y-2">
                          <Label htmlFor={`live-voice-${provider}-workspace-id`}>
                            {t("workspaceId")}
                          </Label>
                          <Input
                            id={`live-voice-${provider}-workspace-id`}
                            onChange={(event) =>
                              upsertDeployment(provider, { workspaceId: event.target.value })
                            }
                            placeholder={t("workspaceIdPlaceholder")}
                            value={deployment.workspaceId ?? ""}
                          />
                        </div>
                      )}
                      {descriptor.fields.includes("appId") && (
                        <div className="space-y-2">
                          <Label htmlFor={`live-voice-${provider}-app-id`}>{t("appId")}</Label>
                          <Input
                            id={`live-voice-${provider}-app-id`}
                            onChange={(event) =>
                              upsertDeployment(provider, { appId: event.target.value })
                            }
                            placeholder={t("appIdPlaceholder")}
                            value={deployment.appId ?? ""}
                          />
                        </div>
                      )}
                      <div className="grid gap-3 sm:grid-cols-2">
                        {descriptor.fields.includes("model") && (
                          <div className="space-y-2">
                            <Label htmlFor={`live-voice-${provider}-model`}>{t("model")}</Label>
                            <Input
                              id={`live-voice-${provider}-model`}
                              onChange={(event) =>
                                upsertDeployment(provider, { model: event.target.value })
                              }
                              placeholder={LIVE_VOICE_DEFAULT_MODELS[provider] ?? ""}
                              value={deployment.model ?? ""}
                            />
                          </div>
                        )}
                        {descriptor.fields.includes("voice") && (
                          <div className="space-y-2">
                            <Label htmlFor={`live-voice-${provider}-voice`}>{t("voice")}</Label>
                            <Input
                              id={`live-voice-${provider}-voice`}
                              onChange={(event) =>
                                upsertDeployment(provider, { voice: event.target.value })
                              }
                              placeholder={LIVE_VOICE_DEFAULT_VOICES[provider] ?? t("voiceDefault")}
                              value={deployment.voice ?? ""}
                            />
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              )
            })
          )}
        </div>

        <div className="flex items-center justify-between gap-4">
          <div className="space-y-1">
            <Label htmlFor="live-voice-fallback">{t("fallback")}</Label>
            <p className="text-xs text-muted-foreground">{t("fallbackHint")}</p>
          </div>
          <Switch
            aria-label={t("fallback")}
            checked={liveVoice.fallbackEnabled}
            id="live-voice-fallback"
            onCheckedChange={(checked) => patch({ fallbackEnabled: checked })}
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="live-voice-instructions">{t("instructions")}</Label>
          <Textarea
            id="live-voice-instructions"
            onChange={(event) => patch({ instructions: event.target.value })}
            placeholder={t("instructionsPlaceholder")}
            value={liveVoice.instructions ?? ""}
          />
          <p className="text-xs text-muted-foreground">{t("privacy")}</p>
        </div>
      </CardContent>
    </Card>
  )
}
