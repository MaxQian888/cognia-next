"use client"

// The daily-wallpaper controls.
//
// This is the only card in the appearance section that turns on a network
// request, so it is written to make that fact visible rather than buried:
//
//   - a standing note naming what gets contacted, above the provider picker
//     rather than in a tooltip,
//   - a status line that reports the LAST OUTCOME, including failures, because
//     a daily wallpaper that quietly stopped working is indistinguishable from
//     one that was never switched on,
//   - a manual "Fetch now" that runs the exact same code path the timer does,
//     so "it works when I click it" can never diverge from "it works on its
//     own".

import { useState } from "react"
import { useFormatter, useTranslations } from "next-intl"
import { AlertTriangleIcon, CheckCircle2Icon, GlobeIcon, RefreshCwIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import { Spinner } from "@/components/ui/spinner"
import { cn, responsiveSelectClass } from "@/lib/utils"
import {
  BING_MARKETS,
  BING_RESOLUTIONS,
  CUSTOM_DAILY_SOURCE_KINDS,
  DAILY_REFRESH_PRESETS,
  DAILY_WALLPAPER_PROVIDERS,
  DEFAULT_DAILY_WALLPAPER,
  MAX_DAILY_KEEP_COUNT,
  MIN_DAILY_KEEP_COUNT,
  type CustomDailyWallpaperSource,
  type DailyWallpaperSettings,
} from "@/types/appearance/daily-wallpaper"

export interface DailyWallpaperCardProps {
  daily: DailyWallpaperSettings
  onChange: (patch: Partial<DailyWallpaperSettings>) => void
  /** Runs the same fetch the timer runs. */
  onFetchNow: () => Promise<void>
}

export function DailyWallpaperCard({ daily, onChange, onFetchNow }: DailyWallpaperCardProps) {
  const t = useTranslations("settings.appearance.wallpaper.daily")
  const format = useFormatter()
  const [fetching, setFetching] = useState(false)

  const merged = { ...DEFAULT_DAILY_WALLPAPER, ...daily }

  const runNow = async () => {
    setFetching(true)
    try {
      await onFetchNow()
    } catch {
      // `runDailyWallpaperFetch` reports every ordinary outcome as a persisted
      // error code rather than a throw, so reaching here means something
      // genuinely unexpected. Swallowing it is still right for this control:
      // the status line above already reads whatever was persisted, and the
      // alternative is an unhandled rejection plus a button stuck spinning.
    } finally {
      setFetching(false)
    }
  }

  const patchCustom = (patch: Partial<CustomDailyWallpaperSource>) => {
    onChange({ custom: { ...merged.custom, ...patch } })
  }

  return (
    <section
      className="space-y-3 rounded-lg border p-3"
      data-testid="wallpaper-daily"
      data-enabled={merged.enabled}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-0.5">
          <Label className="text-xs">{t("title")}</Label>
          <p className="text-[11px] text-muted-foreground">{t("hint")}</p>
        </div>
        <Switch
          checked={merged.enabled}
          onCheckedChange={(checked) => onChange({ enabled: checked })}
          aria-label={t("enableAria")}
          data-testid="daily-enable"
        />
      </div>

      {/* Stated up front, not in a tooltip. This is the one setting in the
          section that contacts a third party. */}
      <p className="flex items-start gap-1.5 rounded-md bg-muted/50 p-2 text-[11px] text-muted-foreground">
        <GlobeIcon className="mt-0.5 size-3 shrink-0" />
        <span>{t("networkNotice")}</span>
      </p>

      <fieldset
        disabled={!merged.enabled}
        className={cn("space-y-3", !merged.enabled && "pointer-events-none opacity-50")}
      >
        <div className="space-y-1.5">
          <Label className="text-[11px]">{t("providerLabel")}</Label>
          <Select
            value={merged.providerId}
            onValueChange={(value) =>
              onChange({ providerId: value as DailyWallpaperSettings["providerId"] })
            }
          >
            <SelectTrigger className={responsiveSelectClass} data-testid="daily-provider">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {DAILY_WALLPAPER_PROVIDERS.map((id) => (
                <SelectItem key={id} value={id}>
                  {t(`provider.${id}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-[11px] text-muted-foreground">
            {t(`providerHint.${merged.providerId}`)}
          </p>
        </div>

        {merged.providerId === "bing" && (
          <div className="grid gap-3 sm:grid-cols-2" data-testid="daily-bing-options">
            <div className="space-y-1.5">
              <Label className="text-[11px]">{t("bing.marketLabel")}</Label>
              <Select
                value={merged.bing.market}
                onValueChange={(value) =>
                  onChange({
                    bing: { ...merged.bing, market: value as (typeof BING_MARKETS)[number] },
                  })
                }
              >
                <SelectTrigger className={responsiveSelectClass} data-testid="daily-bing-market">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {BING_MARKETS.map((market) => (
                    <SelectItem key={market} value={market}>
                      {market === "auto" ? t("bing.marketAuto") : market}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-[11px]">{t("bing.resolutionLabel")}</Label>
              <Select
                value={merged.bing.resolution}
                onValueChange={(value) =>
                  onChange({
                    bing: {
                      ...merged.bing,
                      resolution: value as (typeof BING_RESOLUTIONS)[number],
                    },
                  })
                }
              >
                <SelectTrigger
                  className={responsiveSelectClass}
                  data-testid="daily-bing-resolution"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {BING_RESOLUTIONS.map((resolution) => (
                    <SelectItem key={resolution} value={resolution}>
                      {t(`bing.resolution.${resolution}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        )}

        {merged.providerId === "nasaApod" && (
          <div className="space-y-3" data-testid="daily-nasa-options">
            <div className="space-y-1.5">
              <Label className="text-[11px]">{t("nasa.apiKeyLabel")}</Label>
              <Input
                type="password"
                value={merged.nasaApod.apiKey ?? ""}
                placeholder={t("nasa.apiKeyPlaceholder")}
                onChange={(event) =>
                  onChange({ nasaApod: { ...merged.nasaApod, apiKey: event.target.value } })
                }
                data-testid="daily-nasa-key"
              />
              <p className="text-[11px] text-muted-foreground">{t("nasa.apiKeyHint")}</p>
            </div>
            <ToggleRow
              label={t("nasa.preferHdLabel")}
              hint={t("nasa.preferHdHint")}
              checked={merged.nasaApod.preferHd}
              onChange={(checked) =>
                onChange({ nasaApod: { ...merged.nasaApod, preferHd: checked } })
              }
              testId="daily-nasa-hd"
            />
          </div>
        )}

        {merged.providerId === "custom" && (
          <div className="space-y-3" data-testid="daily-custom-options">
            <div className="space-y-1.5">
              <Label className="text-[11px]">{t("custom.urlLabel")}</Label>
              <Input
                type="url"
                inputMode="url"
                value={merged.custom.url}
                placeholder="https://example.com/daily.json"
                onChange={(event) => patchCustom({ url: event.target.value })}
                data-testid="daily-custom-url"
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-[11px]">{t("custom.kindLabel")}</Label>
              <Select
                value={merged.custom.kind}
                onValueChange={(value) =>
                  patchCustom({ kind: value as (typeof CUSTOM_DAILY_SOURCE_KINDS)[number] })
                }
              >
                <SelectTrigger className={responsiveSelectClass} data-testid="daily-custom-kind">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CUSTOM_DAILY_SOURCE_KINDS.map((kind) => (
                    <SelectItem key={kind} value={kind}>
                      {t(`custom.kind.${kind}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {merged.custom.kind === "json" && (
              <>
                <div className="space-y-1.5">
                  <Label className="text-[11px]">{t("custom.imagePathLabel")}</Label>
                  <Input
                    value={merged.custom.imagePath ?? ""}
                    placeholder={
                      /* i18n-exempt: a literal JSON path example, identical in every language */ "images.0.url"
                    }
                    onChange={(event) => patchCustom({ imagePath: event.target.value })}
                    data-testid="daily-custom-image-path"
                  />
                  <p className="text-[11px] text-muted-foreground">{t("custom.imagePathHint")}</p>
                </div>
                <div className="space-y-1.5">
                  <Label className="text-[11px]">{t("custom.titlePathLabel")}</Label>
                  <Input
                    value={merged.custom.titlePath ?? ""}
                    placeholder={
                      /* i18n-exempt: a literal JSON path example, identical in every language */ "images.0.title"
                    }
                    onChange={(event) => patchCustom({ titlePath: event.target.value })}
                    data-testid="daily-custom-title-path"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label className="text-[11px]">{t("custom.baseUrlLabel")}</Label>
                  <Input
                    value={merged.custom.baseUrl ?? ""}
                    placeholder="https://example.com"
                    onChange={(event) => patchCustom({ baseUrl: event.target.value })}
                    data-testid="daily-custom-base-url"
                  />
                  <p className="text-[11px] text-muted-foreground">{t("custom.baseUrlHint")}</p>
                </div>
              </>
            )}
          </div>
        )}

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label className="text-[11px]">{t("refreshLabel")}</Label>
            <Select
              value={String(merged.refreshHours)}
              onValueChange={(value) => onChange({ refreshHours: Number(value) })}
            >
              <SelectTrigger className={responsiveSelectClass} data-testid="daily-refresh">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {DAILY_REFRESH_PRESETS.map((hours) => (
                  <SelectItem key={hours} value={String(hours)}>
                    {t("refreshOption", { hours })}
                  </SelectItem>
                ))}
                {/* A stored value outside the presets would otherwise render an
                    empty trigger. Reading it back lets the user keep it. */}
                {!DAILY_REFRESH_PRESETS.includes(merged.refreshHours) && (
                  <SelectItem value={String(merged.refreshHours)}>
                    {t("refreshOption", { hours: merged.refreshHours })}
                  </SelectItem>
                )}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <div className="flex items-baseline justify-between">
              <Label className="text-[11px]">{t("keepLabel")}</Label>
              <span className="text-[11px] tabular-nums text-muted-foreground">
                {merged.keepCount}
              </span>
            </div>
            <Slider
              value={[merged.keepCount]}
              min={MIN_DAILY_KEEP_COUNT}
              max={MAX_DAILY_KEEP_COUNT}
              step={1}
              disabled={!merged.enabled}
              onValueChange={([value]) => onChange({ keepCount: value })}
              aria-label={t("keepLabel")}
              data-testid="daily-keep"
            />
            <p className="text-[11px] text-muted-foreground">{t("keepHint")}</p>
          </div>
        </div>

        <div className="space-y-2 border-t pt-3">
          <ToggleRow
            label={t("autoApplyLabel")}
            hint={t("autoApplyHint")}
            checked={merged.autoApply}
            onChange={(checked) => onChange({ autoApply: checked })}
            testId="daily-auto-apply"
          />
          <ToggleRow
            label={t("wifiOnlyLabel")}
            hint={t("wifiOnlyHint")}
            checked={merged.wifiOnly}
            onChange={(checked) => onChange({ wifiOnly: checked })}
            testId="daily-wifi-only"
          />
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-3">
          <div className="min-w-0 flex-1" data-testid="daily-status">
            {merged.lastError ? (
              <p className="flex items-start gap-1.5 text-[11px] text-destructive">
                <AlertTriangleIcon className="mt-0.5 size-3 shrink-0" />
                <span>{t(`error.${merged.lastError.code}`)}</span>
              </p>
            ) : merged.lastFetchedAt ? (
              <p className="flex items-start gap-1.5 text-[11px] text-muted-foreground">
                <CheckCircle2Icon className="mt-0.5 size-3 shrink-0" />
                <span>
                  {t("lastFetched", {
                    when: format.relativeTime(new Date(merged.lastFetchedAt)),
                  })}
                </span>
              </p>
            ) : (
              <p className="text-[11px] text-muted-foreground">{t("neverFetched")}</p>
            )}
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!merged.enabled || fetching}
            onClick={() => void runNow()}
            data-testid="daily-fetch-now"
          >
            {fetching ? (
              <Spinner data-icon="inline-start" />
            ) : (
              <RefreshCwIcon data-icon="inline-start" />
            )}
            {t(fetching ? "fetching" : "fetchNow")}
          </Button>
        </div>
      </fieldset>
    </section>
  )
}

interface ToggleRowProps {
  label: string
  hint: string
  checked: boolean
  onChange: (next: boolean) => void
  testId: string
}

function ToggleRow({ label, hint, checked, onChange, testId }: ToggleRowProps) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="min-w-0 space-y-0.5">
        <Label className="text-[11px]">{label}</Label>
        <p className="text-[11px] text-muted-foreground">{hint}</p>
      </div>
      <Switch
        checked={checked}
        onCheckedChange={onChange}
        aria-label={label}
        data-testid={testId}
      />
    </div>
  )
}
