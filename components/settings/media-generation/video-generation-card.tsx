"use client"

/**
 * Settings → Media generation → Video (ADR-0205, S3/G12).
 *
 * Defaults for every chat video job — the agent's `video_generate` and
 * `/video` — each overridable per call. Only configured providers are listed
 * (the same resolution the job engine uses); on the web build a provider the
 * browser cannot reach is listed but inert (G2). Options a provider's adapter
 * would drop are not offered for it, and switching provider clears them.
 */

import { useMemo } from "react"
import Link from "next/link"
import { useTranslations } from "next-intl"
import { ClapperboardIcon } from "lucide-react"
import {
  DEFAULT_VIDEO_GENERATION_SETTINGS,
  type VideoGenerationSettings,
} from "@cognia/agent-config-types"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import { getProviderDisplayName } from "@/lib/ai/icons"
import { createProviderSettingsSnapshot } from "@/lib/ai/provider-consumption"
import {
  VIDEO_ASPECT_RATIOS,
  VIDEO_DURATIONS_SEC,
  VIDEO_PROVIDERS,
  VIDEO_PROVIDER_OPTIONS,
  VIDEO_RESOLUTIONS,
  videoStartFrameMode,
  type VideoProviderId,
} from "@/lib/ai/media/video-generation-sdk"
import { listConfiguredVideoProviders } from "@/lib/ai/media/video-jobs/defaults"
import { reachesNonCorsHosts } from "@/lib/network/platform-fetch"
import { settingsHref } from "@/lib/settings/deep-link"
import { useSettingsStore } from "@/stores/settings"

/** Select value for "no choice saved": the engine or provider decides. */
const AUTO = "__auto__"

type OptionKey = "durationSec" | "aspectRatio" | "resolution"

export function VideoGenerationCard() {
  const t = useTranslations("settings.mediaGeneration.video")
  const settings = useSettingsStore((store) => store.settings)
  const save = useSettingsStore((store) => store.save)

  const video: VideoGenerationSettings = useMemo(
    () => ({ ...DEFAULT_VIDEO_GENERATION_SETTINGS, ...(settings?.videoGeneration ?? {}) }),
    [settings?.videoGeneration]
  )
  const nativeReach = reachesNonCorsHosts()
  const configured = useMemo(
    () =>
      listConfiguredVideoProviders(
        createProviderSettingsSnapshot({
          defaultProvider: settings?.defaultProvider,
          providerSettings: settings?.providerSettings,
          customProviders: settings?.customProviders,
        }),
        nativeReach
      ),
    [settings?.defaultProvider, settings?.providerSettings, settings?.customProviders, nativeReach]
  )

  const selected = configured.find((provider) => provider.providerId === video.providerId)
  const savedButGone = video.providerId !== undefined && !selected
  const support = selected ? VIDEO_PROVIDER_OPTIONS[selected.providerId] : undefined
  const model = video.model ?? selected?.defaultModel
  const frameMode = model ? videoStartFrameMode(model) : "optional"
  // A saved model the list does not carry (typed via `/video --model`, or
  // dropped from a later release) stays selectable instead of blanking the field.
  const modelChoices = selected
    ? [
        ...VIDEO_PROVIDERS[selected.providerId as VideoProviderId].models,
        ...(video.model &&
        !VIDEO_PROVIDERS[selected.providerId as VideoProviderId].models.includes(video.model)
          ? [video.model]
          : []),
      ]
    : []

  const write = (next: VideoGenerationSettings) => {
    // Drop cleared fields rather than persisting `undefined` keys.
    const clean = Object.fromEntries(
      Object.entries(next).filter(([, value]) => value !== undefined)
    ) as unknown as VideoGenerationSettings
    void save({ videoGeneration: clean })
  }

  const setProvider = (value: string) => {
    // Model and options belong to a provider; a new provider starts from its defaults.
    write({
      agentTool: video.agentTool,
      ...(value === AUTO ? {} : { providerId: value }),
    })
  }

  const setOption = (key: OptionKey, value: string) => {
    const parsed =
      value === AUTO ? undefined : key === "durationSec" ? Number(value) : (value as never)
    write({ ...video, [key]: parsed })
  }

  const optionSelect = (key: OptionKey, choices: readonly (string | number)[]) => (
    <div className="space-y-2">
      <Label>{t(`options.${key}`)}</Label>
      <Select
        value={video[key] === undefined ? AUTO : String(video[key])}
        onValueChange={(value) => setOption(key, value)}
      >
        <SelectTrigger aria-label={t(`options.${key}`)}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={AUTO}>{t("providerDecides")}</SelectItem>
          {choices.map((choice) => (
            <SelectItem key={choice} value={String(choice)}>
              {key === "durationSec" ? t("seconds", { count: Number(choice) }) : choice}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          <ClapperboardIcon className="size-4 text-primary" />
          {t("title")}
        </CardTitle>
        <CardDescription className="text-xs">{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {configured.length === 0 ? (
          <div className="space-y-2 rounded-lg border border-dashed p-3">
            <p className="text-sm">{t("noProviders")}</p>
            <p className="text-xs text-muted-foreground">{t("noProvidersHint")}</p>
            <Button asChild size="sm" variant="outline">
              <Link href={settingsHref("ai-connections")}>{t("openConnections")}</Link>
            </Button>
          </div>
        ) : (
          <>
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label>{t("provider")}</Label>
                <Select value={selected?.providerId ?? AUTO} onValueChange={setProvider}>
                  <SelectTrigger aria-label={t("provider")}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={AUTO}>{t("providerAuto")}</SelectItem>
                    {configured.map((provider) => (
                      <SelectItem
                        key={provider.providerId}
                        value={provider.providerId}
                        disabled={!provider.reachable}
                      >
                        {provider.reachable
                          ? getProviderDisplayName(provider.providerId)
                          : t("desktopRequired", {
                              provider: getProviderDisplayName(provider.providerId),
                            })}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {savedButGone && (
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="text-xs text-destructive">
                      {t("savedProviderGone", {
                        provider: getProviderDisplayName(video.providerId!),
                      })}
                    </p>
                    {/* The select already reads "automatic", so picking it again
                        changes nothing; this is the way to drop the stale choice. */}
                    <Button
                      type="button"
                      size="xs"
                      variant="outline"
                      onClick={() => setProvider(AUTO)}
                    >
                      {t("clearSavedProvider")}
                    </Button>
                  </div>
                )}
              </div>

              {selected && (
                <div className="space-y-2">
                  <Label>{t("model")}</Label>
                  <Select
                    value={video.model ?? AUTO}
                    onValueChange={(value) =>
                      write({ ...video, model: value === AUTO ? undefined : value })
                    }
                  >
                    <SelectTrigger aria-label={t("model")}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={AUTO}>
                        {t("modelDefault", { model: selected.defaultModel })}
                      </SelectItem>
                      {modelChoices.map((id) => (
                        <SelectItem key={id} value={id}>
                          {id}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  {frameMode !== "optional" && (
                    <p className="text-xs text-muted-foreground">
                      {frameMode === "required" ? t("modelNeedsImage") : t("modelTextOnly")}
                    </p>
                  )}
                </div>
              )}
            </div>

            {support && (support.duration || support.aspectRatio || support.resolution) && (
              <div className="grid gap-4 sm:grid-cols-3">
                {support.duration && optionSelect("durationSec", VIDEO_DURATIONS_SEC)}
                {support.aspectRatio && optionSelect("aspectRatio", VIDEO_ASPECT_RATIOS)}
                {support.resolution && optionSelect("resolution", VIDEO_RESOLUTIONS)}
              </div>
            )}
            {!selected && (
              <p className="text-xs text-muted-foreground">{t("optionsNeedProvider")}</p>
            )}
            {!nativeReach && <p className="text-xs text-muted-foreground">{t("webNote")}</p>}
          </>
        )}

        <div className="flex items-start justify-between gap-4 border-t pt-4">
          <div className="space-y-1">
            <Label htmlFor="video-generation-agent-tool">{t("agentTool")}</Label>
            <p className="text-xs text-muted-foreground">{t("agentToolHint")}</p>
          </div>
          <Switch
            id="video-generation-agent-tool"
            aria-label={t("agentTool")}
            checked={video.agentTool}
            onCheckedChange={(checked) => write({ ...video, agentTool: checked })}
          />
        </div>
      </CardContent>
    </Card>
  )
}
