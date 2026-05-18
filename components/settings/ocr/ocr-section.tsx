"use client"

/**
 * OCR settings — entry component rendered from `settings-shell.tsx` when the
 * `ocr` section is active. Mirrors the layout used by `components/settings/
 * search/` (left list of providers, right detail pane), but lighter — OCR
 * config is much smaller per provider than the main LLM-provider system.
 */

import { useCallback, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
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
import { Switch } from "@/components/ui/switch"
import { Separator } from "@/components/ui/separator"
import {
  type OcrProviderCategory,
  DEFAULT_OCR_SETTINGS,
  type UserOcrSettings,
} from "@/lib/ocr/types"

const PROVIDER_LIST: Array<{
  id: string
  category: OcrProviderCategory
}> = [
  { id: "mistral-ocr", category: "document-cloud" },
  { id: "google-vision", category: "document-cloud" },
  { id: "aws-textract", category: "document-cloud" },
  { id: "azure-document-intelligence", category: "document-cloud" },
  { id: "anthropic-vision", category: "llm-vision" },
  { id: "openai-vision", category: "llm-vision" },
  { id: "gemini-vision", category: "llm-vision" },
  { id: "mathpix", category: "specialist" },
  { id: "ocr-space", category: "specialist" },
  { id: "abbyy-cloud", category: "specialist" },
  { id: "nanonets", category: "specialist" },
  { id: "lark-basic", category: "lark" },
  { id: "tesseract-wasm", category: "local" },
  { id: "tesseract-native", category: "local" },
  { id: "windows-media-ocr", category: "local" },
  { id: "apple-vision", category: "local" },
  { id: "mlkit-android", category: "local" },
]

export interface OcrSectionProps {
  settings?: UserOcrSettings
  onChange?: (next: UserOcrSettings) => void
  onClearCache?: () => Promise<void> | void
  onClearProviderCache?: (providerId: string) => Promise<void> | void
}

export function OcrSection(props: OcrSectionProps): React.ReactElement {
  const t = useTranslations()
  const [settings, setSettings] = useState<UserOcrSettings>(props.settings ?? DEFAULT_OCR_SETTINGS)
  const [selectedId, setSelectedId] = useState<string>(PROVIDER_LIST[0]!.id)

  const handleChange = useCallback(
    (next: UserOcrSettings) => {
      setSettings(next)
      props.onChange?.(next)
    },
    [props]
  )

  const grouped = useMemo(() => groupByCategory(PROVIDER_LIST), [])

  return (
    <div className="space-y-6" data-testid="ocr-section">
      <header>
        <h1 className="text-2xl font-semibold">{t("settings.tabs.ocr")}</h1>
        <p className="text-sm text-muted-foreground">{t("settings.descriptions.ocr")}</p>
      </header>

      <Card>
        <CardHeader>
          <CardTitle>{t("ocr.defaults.title")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="ocr-default-provider">{t("ocr.defaults.defaultProvider")}</Label>
              <Select
                value={settings.defaultProviderId}
                onValueChange={(v) =>
                  handleChange({
                    ...settings,
                    defaultProviderId: v as UserOcrSettings["defaultProviderId"],
                  })
                }
              >
                <SelectTrigger id="ocr-default-provider">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="auto">{t("ocr.defaults.auto")}</SelectItem>
                  {PROVIDER_LIST.map((p) => (
                    <SelectItem key={p.id} value={p.id}>
                      {t(`ocr.providers.${p.id}.label`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1">
              <Label htmlFor="ocr-format">{t("ocr.params.format.label")}</Label>
              <Select
                value={settings.defaultFormat}
                onValueChange={(v) =>
                  handleChange({
                    ...settings,
                    defaultFormat: v as UserOcrSettings["defaultFormat"],
                  })
                }
              >
                <SelectTrigger id="ocr-format">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="markdown">{t("ocr.params.format.markdown")}</SelectItem>
                  <SelectItem value="text">{t("ocr.params.format.text")}</SelectItem>
                  <SelectItem value="blocks">{t("ocr.params.format.blocks")}</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1">
              <Label htmlFor="ocr-langs">{t("ocr.params.languages.label")}</Label>
              <Input
                id="ocr-langs"
                value={settings.defaultLanguages.join(",")}
                onChange={(e) =>
                  handleChange({
                    ...settings,
                    defaultLanguages: e.target.value
                      .split(",")
                      .map((s) => s.trim())
                      .filter(Boolean),
                  })
                }
              />
            </div>

            <div className="space-y-1">
              <Label htmlFor="ocr-max-dim">{t("ocr.params.maxImageDimension.label")}</Label>
              <Input
                id="ocr-max-dim"
                type="number"
                min={256}
                max={8192}
                step={64}
                value={settings.maxImageDimension}
                onChange={(e) =>
                  handleChange({
                    ...settings,
                    maxImageDimension: Number(e.target.value) || settings.maxImageDimension,
                  })
                }
              />
            </div>
          </div>

          <Separator />

          <div className="flex items-center justify-between">
            <div>
              <Label className="text-sm">{t("ocr.defaults.cloudFallback")}</Label>
              <p className="text-xs text-muted-foreground">{t("ocr.defaults.cloudFallbackHint")}</p>
            </div>
            <Switch
              checked={settings.cloudFallbackEnabled}
              onCheckedChange={(checked) =>
                handleChange({ ...settings, cloudFallbackEnabled: checked })
              }
              aria-label={t("ocr.defaults.cloudFallback")}
            />
          </div>

          <div className="flex items-center justify-between">
            <div>
              <Label className="text-sm">{t("ocr.defaults.pdfFastPath")}</Label>
              <p className="text-xs text-muted-foreground">{t("ocr.defaults.pdfFastPathHint")}</p>
            </div>
            <Switch
              checked={settings.pdfTextLayerFastPath}
              onCheckedChange={(checked) =>
                handleChange({ ...settings, pdfTextLayerFastPath: checked })
              }
              aria-label={t("ocr.defaults.pdfFastPath")}
            />
          </div>
        </CardContent>
      </Card>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[260px_1fr]">
        <Card>
          <CardHeader>
            <CardTitle>{t("ocr.providers.title")}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            {(Object.entries(grouped) as Array<[OcrProviderCategory, typeof PROVIDER_LIST]>).map(
              ([category, providers]) => (
                <div key={category} className="space-y-1">
                  <p className="text-xs font-medium uppercase text-muted-foreground">
                    {t(`ocr.categories.${category}`)}
                  </p>
                  <ul role="list" className="space-y-1">
                    {providers.map((p) => (
                      <li key={p.id}>
                        <button
                          type="button"
                          className={`w-full rounded px-2 py-1 text-left text-sm hover:bg-muted ${selectedId === p.id ? "bg-muted font-medium" : ""}`}
                          onClick={() => setSelectedId(p.id)}
                          aria-current={selectedId === p.id ? "true" : undefined}
                        >
                          {t(`ocr.providers.${p.id}.label`)}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )
            )}
          </CardContent>
        </Card>

        <Card data-testid="ocr-provider-detail">
          <CardHeader>
            <CardTitle>{t(`ocr.providers.${selectedId}.label`)}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <p className="text-sm text-muted-foreground">
              {t(`ocr.providers.${selectedId}.description`)}
            </p>
            <div className="flex items-center justify-between">
              <Label className="text-sm">{t("ocr.providers.enabled")}</Label>
              <Switch
                checked={settings.providerEnabled[selectedId] !== false}
                onCheckedChange={(checked) =>
                  handleChange({
                    ...settings,
                    providerEnabled: { ...settings.providerEnabled, [selectedId]: checked },
                  })
                }
                aria-label={`${t("ocr.providers.enabled")} (${selectedId})`}
              />
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void props.onClearProviderCache?.(selectedId)}
            >
              {t("ocr.cache.clearProvider")}
            </Button>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t("ocr.cache.title")}</CardTitle>
        </CardHeader>
        <CardContent className="flex items-center gap-4">
          <Button variant="outline" onClick={() => void props.onClearCache?.()}>
            {t("ocr.cache.clear")}
          </Button>
          <p className="text-sm text-muted-foreground">{t("ocr.cache.description")}</p>
        </CardContent>
      </Card>
    </div>
  )
}

function groupByCategory(
  list: typeof PROVIDER_LIST
): Record<OcrProviderCategory, typeof PROVIDER_LIST> {
  const out: Record<OcrProviderCategory, typeof PROVIDER_LIST> = {
    "document-cloud": [],
    "llm-vision": [],
    specialist: [],
    lark: [],
    local: [],
  }
  for (const p of list) {
    out[p.category].push(p)
  }
  return out
}
