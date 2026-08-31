"use client"

import React from "react"
import { useTranslations } from "next-intl"
import { ChevronDown, RotateCcw, Sliders, Sparkles, Plug, Settings2 } from "lucide-react"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Separator } from "@/components/ui/separator"
import { getSchemaForProvider } from "@cognia/provider-core/providers/provider-parameter-schemas"
import { DynamicParameterForm } from "./dynamic-parameter-form"
import type {
  ModelConfig,
  ProviderParameterSchema,
  UserProviderSettings,
} from "@cognia/provider-types"

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
    <div className="group flex items-center gap-1 w-full rounded-md hover:bg-muted/50 transition-colors">
      <CollapsibleTrigger className="group/trigger flex flex-1 min-w-0 items-center gap-2 py-2 px-2 rounded-md">
        <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
        <span className="font-medium text-sm">{label}</span>
        <Badge variant="secondary" className="ml-1 text-xs h-4 px-1.5">
          {count}
        </Badge>
        <ChevronDown className="h-4 w-4 ml-auto transition-transform duration-200 group-data-[state=open]/trigger:rotate-180" />
      </CollapsibleTrigger>
      <Button
        variant="ghost"
        size="icon"
        className="h-6 w-6 mr-2 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
        onClick={onReset}
        title={resetLabel}
        aria-label={resetLabel}
      >
        <RotateCcw className="h-3 w-3" />
      </Button>
    </div>
  )
}

interface ProviderParametersTabProps {
  providerId: string
  settings: UserProviderSettings
  schema?: ProviderParameterSchema
  onSettingsChange: (patch: Partial<UserProviderSettings>) => void | Promise<void>
  modelConfig?: ModelConfig
}

export function ProviderParametersTab({
  providerId,
  settings,
  schema: providedSchema,
  onSettingsChange,
  modelConfig,
}: ProviderParametersTabProps) {
  const t = useTranslations("providerParams")
  const schema = providedSchema ?? getSchemaForProvider(providerId)

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
    void onSettingsChange({
      inferenceDefaults: { ...(settings.inferenceDefaults ?? {}), [key]: value },
    })
  }

  const handleProviderSpecificChange = (key: string, value: unknown) => {
    void onSettingsChange({
      providerSpecificParams: { ...(settings.providerSpecificParams ?? {}), [key]: value },
    })
  }

  const handleConnectionChange = (key: string, value: unknown) => {
    void onSettingsChange({
      connectionParams: { ...(settings.connectionParams ?? {}), [key]: value },
    })
  }

  const handleAdvancedChange = (key: string, value: unknown) => {
    void onSettingsChange({
      advancedParams: { ...(settings.advancedParams ?? {}), [key]: value },
    })
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
            void onSettingsChange({
              inferenceDefaults: {
                temperature: undefined,
                maxTokens: undefined,
                topP: undefined,
                frequencyPenalty: undefined,
                presencePenalty: undefined,
              },
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
                void onSettingsChange({
                  providerSpecificParams: Object.fromEntries(
                    schema.parameters
                      .filter((parameter) => parameter.category === "provider-specific")
                      .map((parameter) => [parameter.key, undefined])
                  ),
                })
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
          label={t("connectionSection")}
          count={paramCount("connection")}
          resetLabel={t("resetAll")}
          onReset={() => {
            void onSettingsChange({
              connectionParams: {
                maxRetries: undefined,
                concurrentLimit: undefined,
              },
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
                void onSettingsChange({
                  advancedParams: Object.fromEntries(
                    schema.parameters
                      .filter((parameter) => parameter.category === "advanced")
                      .map((parameter) => [parameter.key, undefined])
                  ),
                })
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
          onClick={() =>
            void onSettingsChange({
              inferenceDefaults: undefined,
              providerSpecificParams: undefined,
              connectionParams: undefined,
              advancedParams: undefined,
            })
          }
        >
          <RotateCcw className="h-3.5 w-3.5 mr-2" />
          {t("resetAll")}
        </Button>
      </div>
    </div>
  )
}
