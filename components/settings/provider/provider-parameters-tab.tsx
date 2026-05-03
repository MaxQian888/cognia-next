"use client"

import React from "react"
import { useTranslations } from "next-intl"
import { ChevronDown, RotateCcw, Sliders, Sparkles, Plug, Settings2 } from "lucide-react"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { getSchemaForProvider } from "@/lib/ai/providers/provider-parameter-schemas"
import { useSettingsStore } from "@/stores/settings/settings-store"
import { DynamicParameterForm } from "./dynamic-parameter-form"
import type { ModelConfig, UserProviderSettings } from "@/types/provider"

const SECTION_ICONS = {
  inference: Sliders,
  "provider-specific": Sparkles,
  connection: Plug,
  advanced: Settings2,
} as const

interface SectionTriggerProps {
  category: keyof typeof SECTION_ICONS
  label: string
  count: number
  onReset: () => void
  resetLabel: string
}

function SectionTrigger({ category, label, count, onReset, resetLabel }: SectionTriggerProps) {
  const Icon = SECTION_ICONS[category]
  return (
    <CollapsibleTrigger className="flex items-center gap-2 w-full py-2 px-2 rounded-md hover:bg-muted/50 group transition-colors">
      <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
      <span className="font-medium text-sm">{label}</span>
      <Badge variant="secondary" className="ml-1 text-xs h-4 px-1.5">
        {count}
      </Badge>
      <div className="ml-auto flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon"
          className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity"
          onClick={(e) => {
            e.stopPropagation()
            onReset()
          }}
          title={resetLabel}
        >
          <RotateCcw className="h-3 w-3" />
        </Button>
        <ChevronDown className="h-4 w-4 transition-transform duration-200 group-data-[state=open]:rotate-180" />
      </div>
    </CollapsibleTrigger>
  )
}

interface ProviderParametersTabProps {
  providerId: string
  settings: UserProviderSettings
  modelConfig?: ModelConfig
}

export function ProviderParametersTab({
  providerId,
  settings,
  modelConfig,
}: ProviderParametersTabProps) {
  const t = useTranslations("providerParams")
  const schema = getSchemaForProvider(providerId)

  const setProviderInferenceDefaults = useSettingsStore((s) => s.setProviderInferenceDefaults)
  const setProviderSpecificParam = useSettingsStore((s) => s.setProviderSpecificParam)
  const setProviderConnectionParams = useSettingsStore((s) => s.setProviderConnectionParams)
  const setProviderAdvancedParam = useSettingsStore((s) => s.setProviderAdvancedParam)
  const resetProviderParams = useSettingsStore((s) => s.resetProviderParams)

  const inferenceValues: Record<string, unknown> = (settings.inferenceDefaults ?? {}) as Record<
    string,
    unknown
  >
  const providerSpecificValues: Record<string, unknown> = settings.providerSpecificParams ?? {}
  const connectionValues: Record<string, unknown> = (settings.connectionParams ?? {}) as Record<
    string,
    unknown
  >
  const advancedValues: Record<string, unknown> = settings.advancedParams ?? {}

  const hasProviderSpecific = schema.parameters.some((p) => p.category === "provider-specific")
  const hasAdvanced = schema.parameters.some((p) => p.category === "advanced")

  const paramCount = (category: string) =>
    schema.parameters.filter((p) => p.category === category).length

  const handleInferenceChange = (key: string, value: unknown) => {
    setProviderInferenceDefaults(providerId, { [key]: value })
  }

  const handleProviderSpecificChange = (key: string, value: unknown) => {
    setProviderSpecificParam(providerId, key, value)
  }

  const handleConnectionChange = (key: string, value: unknown) => {
    setProviderConnectionParams(providerId, { [key]: value })
  }

  const handleAdvancedChange = (key: string, value: unknown) => {
    setProviderAdvancedParam(providerId, key, value)
  }

  return (
    <div className="space-y-3 py-2">
      {/* Inference section - always shown, open by default */}
      <Collapsible defaultOpen>
        <SectionTrigger
          category="inference"
          label={t("inference")}
          count={paramCount("inference")}
          resetLabel={t("resetAll")}
          onReset={() => {
            setProviderInferenceDefaults(providerId, {
              temperature: undefined,
              maxTokens: undefined,
              topP: undefined,
              frequencyPenalty: undefined,
              presencePenalty: undefined,
            })
          }}
        />
        <CollapsibleContent className="px-2 pt-2">
          <DynamicParameterForm
            parameters={schema.parameters}
            values={inferenceValues}
            onChange={handleInferenceChange}
            modelConfig={modelConfig}
            filterCategory="inference"
          />
        </CollapsibleContent>
      </Collapsible>

      {/* Provider-specific - only if schema has provider-specific params */}
      {hasProviderSpecific && (
        <>
          <Separator />
          <Collapsible defaultOpen>
            <SectionTrigger
              category="provider-specific"
              label={t("providerSpecific")}
              count={paramCount("provider-specific")}
              resetLabel={t("resetAll")}
              onReset={() => {
                schema.parameters
                  .filter((p) => p.category === "provider-specific")
                  .forEach((p) => setProviderSpecificParam(providerId, p.key, undefined))
              }}
            />
            <CollapsibleContent className="px-2 pt-2">
              <DynamicParameterForm
                parameters={schema.parameters}
                values={providerSpecificValues}
                onChange={handleProviderSpecificChange}
                modelConfig={modelConfig}
                filterCategory="provider-specific"
              />
            </CollapsibleContent>
          </Collapsible>
        </>
      )}

      {/* Connection - collapsed by default */}
      <Separator />
      <Collapsible>
        <SectionTrigger
          category="connection"
          label={t("connection")}
          count={paramCount("connection")}
          resetLabel={t("resetAll")}
          onReset={() => {
            setProviderConnectionParams(providerId, {
              timeout: undefined,
              maxRetries: undefined,
              retryDelay: undefined,
            })
          }}
        />
        <CollapsibleContent className="px-2 pt-2">
          <DynamicParameterForm
            parameters={schema.parameters}
            values={connectionValues}
            onChange={handleConnectionChange}
            modelConfig={modelConfig}
            filterCategory="connection"
          />
        </CollapsibleContent>
      </Collapsible>

      {/* Advanced - collapsed by default, only if has advanced params */}
      {hasAdvanced && (
        <>
          <Separator />
          <Collapsible>
            <SectionTrigger
              category="advanced"
              label={t("advanced")}
              count={paramCount("advanced")}
              resetLabel={t("resetAll")}
              onReset={() => {
                schema.parameters
                  .filter((p) => p.category === "advanced")
                  .forEach((p) => setProviderAdvancedParam(providerId, p.key, undefined))
              }}
            />
            <CollapsibleContent className="px-2 pt-2">
              <DynamicParameterForm
                parameters={schema.parameters}
                values={advancedValues}
                onChange={handleAdvancedChange}
                modelConfig={modelConfig}
                filterCategory="advanced"
              />
            </CollapsibleContent>
          </Collapsible>
        </>
      )}

      {/* Reset button */}
      <div className="pt-2 px-2">
        <Button
          variant="outline"
          size="sm"
          className="w-full"
          onClick={() => resetProviderParams(providerId)}
        >
          <RotateCcw className="h-3.5 w-3.5 mr-2" />
          {t("resetAll")}
        </Button>
      </div>
    </div>
  )
}
