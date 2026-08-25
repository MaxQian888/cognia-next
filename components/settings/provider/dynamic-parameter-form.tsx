"use client"

import React, { useState } from "react"
import { useTranslations } from "next-intl"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Textarea } from "@/components/ui/textarea"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { cn } from "@/lib/utils"
import type { ParameterDefinition, ParameterCategory, ModelConfig } from "@cognia/provider-types"
import { shouldShowParameter } from "@cognia/provider-core/providers/parameter-resolver"

interface DynamicParameterFormProps {
  parameters: ParameterDefinition[]
  values: Record<string, unknown>
  onChange: (key: string, value: unknown) => void
  modelConfig?: ModelConfig
  currentValues?: Record<string, unknown>
  sourceLabels?: Record<string, "session" | "provider" | "global">
  filterCategory?: ParameterCategory
}

export function DynamicParameterForm({
  parameters,
  values,
  onChange,
  modelConfig,
  currentValues,
  sourceLabels,
  filterCategory,
}: DynamicParameterFormProps) {
  const t = useTranslations("providerParams")

  const tKey = (key: string): string =>
    key.startsWith("providerParams.")
      ? t(key.slice("providerParams.".length) as Parameters<typeof t>[0])
      : key

  function getColSpan(param: ParameterDefinition): string {
    if (param.type === "slider" || param.type === "json") return "col-span-full"
    if (param.type === "select" && (param.validation?.options?.length ?? 0) >= 4)
      return "col-span-full"
    return ""
  }

  const effectiveCurrentValues = currentValues ?? values

  const visibleParameters = parameters.filter((param) => {
    if (filterCategory && param.category !== filterCategory) return false
    return shouldShowParameter(param, modelConfig, effectiveCurrentValues)
  })

  if (visibleParameters.length === 0) return null

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
      {visibleParameters.map((param) => {
        const rawValue = values[param.key]
        const value = rawValue !== undefined ? rawValue : param.defaultValue
        const source = sourceLabels?.[param.key]

        return (
          <div
            key={param.key}
            className={cn("bg-muted/30 rounded-md p-3 flex flex-col gap-1.5", getColSpan(param))}
          >
            <div className="flex items-center justify-between">
              <Label htmlFor={param.key} className="text-sm font-medium">
                {tKey(param.label)}
              </Label>
              {source && (
                <span
                  className={cn(
                    "inline-flex items-center rounded-pill px-2 py-0.5 text-xs font-medium",
                    source === "session" &&
                      "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400",
                    source === "provider" &&
                      "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
                    source === "global" &&
                      "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400"
                  )}
                >
                  {source === "session"
                    ? t("sourceSession")
                    : source === "provider"
                      ? t("sourceProvider")
                      : t("sourceGlobal")}
                </span>
              )}
            </div>

            <ParameterControl param={param} value={value} onChange={onChange} tKey={tKey} />

            {param.description && (
              <p className="text-xs text-muted-foreground">{tKey(param.description)}</p>
            )}
          </div>
        )
      })}
    </div>
  )
}

interface ParameterControlProps {
  param: ParameterDefinition
  value: unknown
  onChange: (key: string, value: unknown) => void
  tKey: (key: string) => string
}

function ParameterControl({ param, value, onChange, tKey }: ParameterControlProps) {
  const t = useTranslations("providerParams")
  const [error, setError] = useState<string | null>(null)
  const jsonDraftRef = React.useRef<string | null>(null)

  const control = (() => {
    switch (param.type) {
      case "slider": {
        const numValue = typeof value === "number" ? value : (param.defaultValue as number)
        const min = param.validation?.min ?? 0
        const max = param.validation?.max ?? 1
        const step = param.validation?.step ?? 0.1

        return (
          <div className="flex items-center gap-3">
            <Slider
              id={param.key}
              min={min}
              max={max}
              step={step}
              value={[numValue]}
              onValueChange={([val]) => onChange(param.key, val)}
              className="flex-1"
            />
            <span className="w-12 text-right text-sm tabular-nums text-muted-foreground">
              {numValue}
            </span>
          </div>
        )
      }

      case "select": {
        const strValue = typeof value === "string" ? value : String(param.defaultValue ?? "")
        const options = param.validation?.options ?? []

        return (
          <Select value={strValue} onValueChange={(val) => onChange(param.key, val)}>
            <SelectTrigger id={param.key}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {options.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {tKey(opt.label)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )
      }

      case "number": {
        const numValue = typeof value === "number" ? value : (param.defaultValue as number)
        const min = param.validation?.min
        const max = param.validation?.max

        return (
          <Input
            id={param.key}
            type="number"
            value={numValue}
            min={min}
            max={max}
            onChange={(e) => {
              const v = e.target.valueAsNumber
              if (min !== undefined && v < min) setError(t("outOfRange", { min, max: max ?? "∞" }))
              else if (max !== undefined && v > max)
                setError(t("outOfRange", { min: min ?? 0, max }))
              else setError(null)
              onChange(param.key, v)
            }}
          />
        )
      }

      case "toggle": {
        const boolValue = typeof value === "boolean" ? value : Boolean(param.defaultValue)

        return (
          <Switch
            id={param.key}
            checked={boolValue}
            onCheckedChange={(checked) => onChange(param.key, checked)}
          />
        )
      }

      case "text": {
        const strValue = typeof value === "string" ? value : String(param.defaultValue ?? "")

        return (
          <Input
            id={param.key}
            type="text"
            value={strValue}
            onChange={(e) => onChange(param.key, e.target.value)}
          />
        )
      }

      case "json": {
        const strVal = typeof value === "string" ? value : JSON.stringify(value ?? {}, null, 2)

        return (
          <Textarea
            id={param.key}
            value={strVal}
            onChange={(e) => {
              jsonDraftRef.current = e.target.value
              onChange(param.key, e.target.value)
              setError(null)
            }}
            onBlur={(e) => {
              const textToValidate = jsonDraftRef.current ?? e.target.value
              try {
                JSON.parse(textToValidate)
              } catch {
                setError(t("invalidJson"))
              }
            }}
            className="font-mono text-xs min-h-[80px] resize-y"
          />
        )
      }

      default:
        return null
    }
  })()

  return (
    <>
      {control}
      {error && <p className="text-destructive text-xs mt-1">{error}</p>}
    </>
  )
}
