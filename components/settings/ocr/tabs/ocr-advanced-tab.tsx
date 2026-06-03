"use client"

/**
 * OCR Advanced tab — per-provider overrides written to
 * `settings.providerConfig[providerId]`.
 *
 * Field visibility is driven by a static map keyed by provider id. Local
 * providers only get format + languages overrides; cloud document providers
 * gain region; LLM-vision providers gain modelVariant + promptTemplate.
 */

import { useTranslations } from "next-intl"
import { Eraser, RotateCcw } from "lucide-react"
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
import { Textarea } from "@/components/ui/textarea"
import type { OcrProviderConfig, OcrOutputFormat } from "@/types/ocr"

interface OcrAdvancedTabProps {
  providerId: string
  config: OcrProviderConfig
  onConfigChange: (next: OcrProviderConfig) => void
  onClearProviderCache: () => void | Promise<void>
}

/** Providers that expose a "model variant" override (cloud + LLM vision). */
const PROVIDERS_WITH_MODEL_VARIANT: ReadonlySet<string> = new Set<string>([
  "mistral-ocr",
  "anthropic-vision",
  "openai-vision",
  "gemini-vision",
  "mathpix",
])

/** Providers that expose a "region" override (AWS / Azure). */
const PROVIDERS_WITH_REGION: ReadonlySet<string> = new Set<string>([
  "aws-textract",
  "azure-document-intelligence",
])

/** Providers that expose a prompt-template override (LLM vision only). */
const PROVIDERS_WITH_PROMPT_TEMPLATE: ReadonlySet<string> = new Set<string>([
  "anthropic-vision",
  "openai-vision",
  "gemini-vision",
])

const FORMAT_OPTIONS: ReadonlyArray<{ value: OcrOutputFormat; key: string }> = [
  { value: "markdown", key: "params.format.markdown" },
  { value: "text", key: "params.format.text" },
  { value: "blocks", key: "params.format.blocks" },
]

const INHERIT_FORMAT_VALUE = "__inherit__"

export function OcrAdvancedTab({
  providerId,
  config,
  onConfigChange,
  onClearProviderCache,
}: OcrAdvancedTabProps): React.ReactElement {
  const t = useTranslations()

  const format = typeof config.format === "string" ? (config.format as OcrOutputFormat) : null
  const languages = typeof config.languages === "string" ? (config.languages as string) : ""
  const modelVariant =
    typeof config.modelVariant === "string" ? (config.modelVariant as string) : ""
  const region = typeof config.region === "string" ? (config.region as string) : ""
  const promptTemplate =
    typeof config.promptTemplate === "string" ? (config.promptTemplate as string) : ""

  const showRegion = PROVIDERS_WITH_REGION.has(providerId)
  const showModelVariant = PROVIDERS_WITH_MODEL_VARIANT.has(providerId)
  const showPromptTemplate = PROVIDERS_WITH_PROMPT_TEMPLATE.has(providerId)

  const update = (patch: OcrProviderConfig) => {
    onConfigChange({ ...config, ...patch })
  }
  const remove = (key: string) => {
    const next = { ...config }
    delete next[key]
    onConfigChange(next)
  }

  return (
    <div className="space-y-5" data-testid="ocr-advanced-tab">
      <header className="space-y-1">
        <h4 className="text-sm font-medium">{t("ocr.advanced.title")}</h4>
        <p className="text-xs text-muted-foreground">{t("ocr.advanced.description")}</p>
      </header>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="ocr-adv-format">{t("ocr.advanced.formatOverride")}</Label>
          <Select
            value={format ?? INHERIT_FORMAT_VALUE}
            onValueChange={(v) => {
              if (v === INHERIT_FORMAT_VALUE) {
                remove("format")
              } else {
                update({ format: v as OcrOutputFormat })
              }
            }}
          >
            <SelectTrigger id="ocr-adv-format">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={INHERIT_FORMAT_VALUE}>
                {t("ocr.advanced.formatInherit")}
              </SelectItem>
              {FORMAT_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {t(`ocr.${opt.key}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1.5">
          <Label htmlFor="ocr-adv-langs">{t("ocr.advanced.languagesOverride")}</Label>
          <Input
            id="ocr-adv-langs"
            value={languages}
            onChange={(e) => {
              if (e.target.value.trim() === "") {
                remove("languages")
              } else {
                update({ languages: e.target.value })
              }
            }}
            placeholder={t("ocr.advanced.languagesHint")}
          />
        </div>

        {showModelVariant && (
          <div className="space-y-1.5" data-testid="ocr-adv-model-variant">
            <Label htmlFor="ocr-adv-model">{t("ocr.advanced.modelVariant")}</Label>
            <Input
              id="ocr-adv-model"
              value={modelVariant}
              onChange={(e) => {
                if (e.target.value.trim() === "") {
                  remove("modelVariant")
                } else {
                  update({ modelVariant: e.target.value })
                }
              }}
            />
          </div>
        )}

        {showRegion && (
          <div className="space-y-1.5" data-testid="ocr-adv-region">
            <Label htmlFor="ocr-adv-region">{t("ocr.advanced.region")}</Label>
            <Input
              id="ocr-adv-region"
              value={region}
              onChange={(e) => {
                if (e.target.value.trim() === "") {
                  remove("region")
                } else {
                  update({ region: e.target.value })
                }
              }}
            />
          </div>
        )}
      </div>

      {showPromptTemplate && (
        <div className="space-y-1.5" data-testid="ocr-adv-prompt-template">
          <Label htmlFor="ocr-adv-prompt">{t("ocr.advanced.promptTemplate")}</Label>
          <Textarea
            id="ocr-adv-prompt"
            value={promptTemplate}
            onChange={(e) => {
              if (e.target.value.trim() === "") {
                remove("promptTemplate")
              } else {
                update({ promptTemplate: e.target.value })
              }
            }}
            rows={4}
          />
        </div>
      )}

      <Separator />

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => onConfigChange({})}
          data-testid="ocr-adv-reset"
        >
          <RotateCcw className="mr-1.5 h-3.5 w-3.5" />
          {t("ocr.advanced.reset")}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => void onClearProviderCache()}
          data-testid="ocr-adv-clear-cache"
        >
          <Eraser className="mr-1.5 h-3.5 w-3.5" />
          {t("ocr.advanced.clearProviderCache")}
        </Button>
      </div>
    </div>
  )
}
