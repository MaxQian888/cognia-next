"use client"

/**
 * Auto-Router panel — single-form replacement for the old "OCR Defaults"
 * card. Rendered when the Auto-Router pseudo-item is selected in the
 * sidebar. No tabs; a single Card-style form.
 */

import { useTranslations } from "next-intl"
import { Eraser, Sparkles } from "lucide-react"
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
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/ui/switch"
import type { OcrOutputFormat, UserOcrSettings } from "@/lib/ocr/types"

/** A provider option as rendered in the default-provider dropdown. */
export interface AutoRouterProviderOption {
  id: string
  label: string
  /** Set true to surface this entry in the cloud-fallback dropdown. */
  isCloudOrVision: boolean
}

interface OcrAutoRouterPanelProps {
  settings: UserOcrSettings
  onChange: (next: UserOcrSettings) => void
  providers: AutoRouterProviderOption[]
  onClearCache: () => void | Promise<void>
}

export function OcrAutoRouterPanel({
  settings,
  onChange,
  providers,
  onClearCache,
}: OcrAutoRouterPanelProps): React.ReactElement {
  const t = useTranslations()
  const cloudProviders = providers.filter((p) => p.isCloudOrVision)

  return (
    <div className="flex h-full flex-col overflow-y-auto" data-testid="ocr-auto-router-panel">
      <div className="border-b px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-muted">
            <Sparkles className="h-4 w-4" aria-hidden="true" />
          </div>
          <div>
            <h3 className="text-sm font-semibold">{t("ocr.autoRouter.title")}</h3>
            <p className="text-xs text-muted-foreground">{t("ocr.autoRouter.description")}</p>
          </div>
        </div>
      </div>

      <div className="space-y-6 p-4">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label htmlFor="ocr-default-provider">{t("ocr.autoRouter.defaultProvider")}</Label>
            <Select
              value={settings.defaultProviderId}
              onValueChange={(v) => onChange({ ...settings, defaultProviderId: v })}
            >
              <SelectTrigger id="ocr-default-provider">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="auto">{t("ocr.defaults.auto")}</SelectItem>
                {providers.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="ocr-default-format">{t("ocr.autoRouter.defaultFormat")}</Label>
            <Select
              value={settings.defaultFormat}
              onValueChange={(v) => onChange({ ...settings, defaultFormat: v as OcrOutputFormat })}
            >
              <SelectTrigger id="ocr-default-format">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="markdown">{t("ocr.params.format.markdown")}</SelectItem>
                <SelectItem value="text">{t("ocr.params.format.text")}</SelectItem>
                <SelectItem value="blocks">{t("ocr.params.format.blocks")}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="ocr-default-langs">{t("ocr.autoRouter.defaultLanguages")}</Label>
            <Input
              id="ocr-default-langs"
              value={settings.defaultLanguages.join(",")}
              onChange={(e) =>
                onChange({
                  ...settings,
                  defaultLanguages: e.target.value
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean),
                })
              }
              placeholder={t("ocr.autoRouter.languagesHint")}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="ocr-max-dim">{t("ocr.autoRouter.maxImageDimension")}</Label>
            <Input
              id="ocr-max-dim"
              type="number"
              min={256}
              max={8192}
              step={64}
              value={settings.maxImageDimension}
              onChange={(e) =>
                onChange({
                  ...settings,
                  maxImageDimension: Number(e.target.value) || settings.maxImageDimension,
                })
              }
            />
            <p className="text-xs text-muted-foreground">{t("ocr.autoRouter.maxImageHint")}</p>
          </div>
        </div>

        <Separator />

        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <Label className="text-sm">{t("ocr.autoRouter.cloudFallback")}</Label>
              <p className="text-xs text-muted-foreground">
                {t("ocr.autoRouter.cloudFallbackHint")}
              </p>
            </div>
            <Switch
              checked={settings.cloudFallbackEnabled}
              onCheckedChange={(checked) =>
                onChange({ ...settings, cloudFallbackEnabled: checked })
              }
              aria-label={t("ocr.autoRouter.cloudFallback")}
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="ocr-cloud-fallback-provider">
              {t("ocr.autoRouter.cloudFallbackProvider")}
            </Label>
            <Select
              value={settings.cloudFallbackProviderId ?? ""}
              onValueChange={(v) =>
                onChange({
                  ...settings,
                  cloudFallbackProviderId: v === "" ? null : v,
                })
              }
              disabled={!settings.cloudFallbackEnabled}
            >
              <SelectTrigger id="ocr-cloud-fallback-provider">
                <SelectValue placeholder={t("ocr.autoRouter.noFallbackProvider")} />
              </SelectTrigger>
              <SelectContent>
                {cloudProviders.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center justify-between">
            <div>
              <Label className="text-sm">{t("ocr.autoRouter.pdfFastPath")}</Label>
              <p className="text-xs text-muted-foreground">{t("ocr.autoRouter.pdfFastPathHint")}</p>
            </div>
            <Switch
              checked={settings.pdfTextLayerFastPath}
              onCheckedChange={(checked) =>
                onChange({ ...settings, pdfTextLayerFastPath: checked })
              }
              aria-label={t("ocr.autoRouter.pdfFastPath")}
            />
          </div>
        </div>

        <Separator />

        <div className="space-y-2">
          <div className="space-y-1.5">
            <Label htmlFor="ocr-cache-ttl">{t("ocr.autoRouter.cacheTtlDays")}</Label>
            <Input
              id="ocr-cache-ttl"
              type="number"
              min={0}
              max={3650}
              step={1}
              value={settings.cacheTtlDays}
              onChange={(e) =>
                onChange({
                  ...settings,
                  cacheTtlDays:
                    e.target.value === ""
                      ? settings.cacheTtlDays
                      : Math.max(0, Number(e.target.value)),
                })
              }
            />
            <p className="text-xs text-muted-foreground">{t("ocr.autoRouter.cacheTtlHint")}</p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void onClearCache()}
            data-testid="ocr-clear-all-cache"
          >
            <Eraser className="mr-1.5 h-3.5 w-3.5" />
            {t("ocr.autoRouter.clearAllCache")}
          </Button>
        </div>
      </div>
    </div>
  )
}
