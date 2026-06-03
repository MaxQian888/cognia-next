"use client"

/**
 * Auto-Router panel — three tabs:
 *   - Defaults: provider / format / language / cache TTL / cloud fallback /
 *     PDF fast-path (the original form, unchanged).
 *   - Platform Overrides: per-OS local-engine ranking.
 *   - Cache: global Dexie cache browser.
 *
 * Rendered when the Auto-Router pseudo-item is selected in the sidebar.
 */

import { useTranslations } from "next-intl"
import { Eraser, Sparkles, Wand2 } from "lucide-react"
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import type { OcrOutputFormat, UserOcrSettings } from "@/types/ocr"
import { OcrPlatformOverridesTab } from "./ocr-platform-overrides-tab"
import { OcrCacheTab } from "./ocr-cache-tab"

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
  /** When provided, the header gains a "Run setup wizard" button. */
  onOpenWizard?: () => void
}

export function OcrAutoRouterPanel({
  settings,
  onChange,
  providers,
  onClearCache,
  onOpenWizard,
}: OcrAutoRouterPanelProps): React.ReactElement {
  const t = useTranslations()

  return (
    <div className="flex h-full flex-col overflow-y-auto" data-testid="ocr-auto-router-panel">
      <div className="border-b px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-muted">
              <Sparkles className="h-4 w-4" aria-hidden="true" />
            </div>
            <div>
              <h3 className="text-sm font-semibold">{t("ocr.autoRouter.title")}</h3>
              <p className="text-xs text-muted-foreground">{t("ocr.autoRouter.description")}</p>
            </div>
          </div>
          {onOpenWizard && (
            <Button
              variant="outline"
              size="sm"
              onClick={onOpenWizard}
              data-testid="ocr-open-wizard"
            >
              <Wand2 className="mr-1.5 h-3.5 w-3.5" />
              {t("ocr.wizard.openButton")}
            </Button>
          )}
        </div>
      </div>

      <Tabs defaultValue="defaults" className="flex flex-1 flex-col">
        <div className="border-b px-4 pt-2">
          <TabsList>
            <TabsTrigger value="defaults" data-testid="ocr-auto-router-tab-defaults">
              {t("ocr.autoRouter.tabs.defaults")}
            </TabsTrigger>
            <TabsTrigger
              value="platform-overrides"
              data-testid="ocr-auto-router-tab-platform-overrides"
            >
              {t("ocr.autoRouter.tabs.platformOverrides")}
            </TabsTrigger>
            <TabsTrigger value="cache" data-testid="ocr-auto-router-tab-cache">
              {t("ocr.autoRouter.tabs.cache")}
            </TabsTrigger>
          </TabsList>
        </div>

        <TabsContent value="defaults" className="flex-1 p-4">
          <DefaultsTabContent
            settings={settings}
            onChange={onChange}
            providers={providers}
            onClearCache={onClearCache}
          />
        </TabsContent>

        <TabsContent value="platform-overrides" className="flex-1 p-4">
          <OcrPlatformOverridesTab settings={settings} onChange={onChange} />
        </TabsContent>

        <TabsContent value="cache" className="flex-1 p-4">
          <OcrCacheTab />
        </TabsContent>
      </Tabs>
    </div>
  )
}

function DefaultsTabContent({
  settings,
  onChange,
  providers,
  onClearCache,
}: Omit<OcrAutoRouterPanelProps, "onOpenWizard">) {
  const t = useTranslations()
  const cloudProviders = providers.filter((p) => p.isCloudOrVision)

  return (
    <div className="space-y-6">
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
            <p className="text-xs text-muted-foreground">{t("ocr.autoRouter.cloudFallbackHint")}</p>
          </div>
          <Switch
            checked={settings.cloudFallbackEnabled}
            onCheckedChange={(checked) => onChange({ ...settings, cloudFallbackEnabled: checked })}
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
            onCheckedChange={(checked) => onChange({ ...settings, pdfTextLayerFastPath: checked })}
            aria-label={t("ocr.autoRouter.pdfFastPath")}
          />
        </div>

        <div className="flex items-center justify-between">
          <div>
            <Label className="text-sm">{t("ocr.autoRouter.inboundImages")}</Label>
            <p className="text-xs text-muted-foreground">{t("ocr.autoRouter.inboundImagesHint")}</p>
          </div>
          <Switch
            checked={settings.ocrInboundImages !== false}
            onCheckedChange={(checked) => onChange({ ...settings, ocrInboundImages: checked })}
            aria-label={t("ocr.autoRouter.inboundImages")}
          />
        </div>

        <div className="flex items-center justify-between">
          <div>
            <Label className="text-sm">{t("ocr.autoRouter.confidenceEscalation")}</Label>
            <p className="text-xs text-muted-foreground">
              {t("ocr.autoRouter.confidenceEscalationHint")}
            </p>
          </div>
          <Switch
            checked={settings.confidenceEscalation === "escalate"}
            onCheckedChange={(checked) =>
              onChange({ ...settings, confidenceEscalation: checked ? "escalate" : "off" })
            }
            aria-label={t("ocr.autoRouter.confidenceEscalation")}
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
  )
}
