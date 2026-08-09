"use client"

/**
 * OCR Advanced tab — per-provider overrides written to
 * `settings.providerConfig[providerId]`.
 *
 * Fields are rendered from the package-owned OCR parameter schema so the
 * provider adapter and settings UI cannot silently drift apart.
 */

import { useTranslations } from "next-intl"
import { Eraser, RotateCcw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { DynamicParameterForm } from "@/components/settings/provider/dynamic-parameter-form"
import { getOcrParameterSchema } from "@cognia/ocr/ocr-parameter-schemas"
import type { ParameterDefinition } from "@cognia/provider-types"
import type { OcrProviderConfig } from "@/types/ocr"

interface OcrAdvancedTabProps {
  providerId: string
  config: OcrProviderConfig
  onConfigChange: (next: OcrProviderConfig) => void
  onClearProviderCache: () => void | Promise<void>
}

export function OcrAdvancedTab({
  providerId,
  config,
  onConfigChange,
  onClearProviderCache,
}: OcrAdvancedTabProps): React.ReactElement {
  const t = useTranslations()

  const schema = getOcrParameterSchema(providerId)
  const values: OcrProviderConfig = { ...config }
  // Read compatibility for the pre-schema UI, which wrote modelVariant.
  if (values.model === undefined && typeof values.modelVariant === "string") {
    values.model = values.modelVariant
  }
  const parameters: ParameterDefinition[] = (schema?.parameters ?? []).map((parameter) => ({
    ...parameter,
    label: t(parameter.label),
    description: parameter.description ? t(parameter.description) : "",
    validation: parameter.validation?.options
      ? {
          ...parameter.validation,
          options: parameter.validation.options.map((option) => ({
            ...option,
            label: option.label.startsWith("ocr.") ? t(option.label) : option.label,
          })),
        }
      : parameter.validation,
  }))

  const update = (key: string, value: unknown) => {
    const next = { ...config, [key]: value }
    if (key === "model") delete next.modelVariant
    if (providerId === "local-http" && key === "endpoint") {
      next.allowLan = false
      delete next.confirmedLanEndpoint
    }
    if (providerId === "local-http" && key === "allowLan") {
      if (value === true && typeof values.endpoint === "string") {
        next.confirmedLanEndpoint = values.endpoint.trim()
      } else {
        delete next.confirmedLanEndpoint
      }
    }
    onConfigChange(next)
  }

  return (
    <div className="space-y-5" data-testid="ocr-advanced-tab">
      <header className="space-y-1">
        <h4 className="text-sm font-medium">{t("ocr.advanced.title")}</h4>
        <p className="text-xs text-muted-foreground">{t("ocr.advanced.description")}</p>
      </header>

      <DynamicParameterForm parameters={parameters} values={values} onChange={update} />

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
