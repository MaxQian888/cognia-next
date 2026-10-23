"use client"

import { useId, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import type { AppSettings } from "@cognia/agent-config-types"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { saveSettings } from "@/lib/db/settings"
import { useSettingsStore } from "@/stores/settings"

const MINUTE_MS = 60_000
const DURATION_FIELDS = [
  ["maxWaitMs", "maximum"],
  ["usageLimitRecheckMs", "recheck"],
] as const
type DurationKey = (typeof DURATION_FIELDS)[number][0]
type RuntimePreferences = NonNullable<AppSettings["claudeCodeRuntime"]>
type RetryPreferences = NonNullable<RuntimePreferences["unattendedRetry"]>

function validMinutes(value: number): boolean {
  return Number.isInteger(value) && value >= 1 && value <= 180
}

function durationMinutes(value: number | undefined, fallback: number): number {
  return validDuration(value) ? value / MINUTE_MS : fallback
}

function validDuration(value: number | undefined): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= MINUTE_MS &&
    value <= 180 * MINUTE_MS
  )
}

// SDK-specific capabilities and invocation lifetime are separate from the
// built-in tool OS sandbox controlled by SandboxEnableCard.
export function ClaudeCodeRuntimeCard() {
  const t = useTranslations("settings.sandbox.claudeCodeRuntime")
  const settings = useSettingsStore((state) => state.settings)
  const stored = settings?.claudeCodeRuntime ?? {}
  const id = useId()
  const [errors, setErrors] = useState<Partial<Record<DurationKey, boolean>>>({})
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState(false)
  const savingRef = useRef(false)
  const minutes = {
    maxWaitMs: durationMinutes(stored.unattendedRetry?.maxWaitMs, 30),
    usageLimitRecheckMs: durationMinutes(stored.unattendedRetry?.usageLimitRecheckMs, 1),
  }
  const retryEnabled = stored.unattendedRetry?.enabled === true
  const saveRuntime = async (patch: RuntimePreferences) => {
    // Keep pending controls stable; the atomic updater also protects writes
    // across remounts and other callers sharing the settings save queue.
    if (savingRef.current) return
    savingRef.current = true
    setSaving(true)
    setSaveError(false)
    try {
      const next = await saveSettings((current) => {
        const latest = current.claudeCodeRuntime ?? {}
        const latestRetry = latest.unattendedRetry ?? {}
        const retryPatch = patch.unattendedRetry
        return {
          claudeCodeRuntime: {
            ...latest,
            ...patch,
            ...(retryPatch
              ? {
                  unattendedRetry: {
                    ...latestRetry,
                    ...(retryPatch.enabled === true
                      ? {
                          maxWaitMs: validDuration(latestRetry.maxWaitMs)
                            ? latestRetry.maxWaitMs
                            : 30 * MINUTE_MS,
                          usageLimitRecheckMs: validDuration(latestRetry.usageLimitRecheckMs)
                            ? latestRetry.usageLimitRecheckMs
                            : MINUTE_MS,
                        }
                      : {}),
                    ...retryPatch,
                  },
                }
              : {}),
          },
        }
      })
      useSettingsStore.setState({ settings: next })
    } catch {
      setSaveError(true)
    } finally {
      savingRef.current = false
      setSaving(false)
    }
  }
  const updateRetry = (patch: RetryPreferences) => {
    void saveRuntime({ unattendedRetry: patch })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent>
        <FieldGroup aria-busy={saving}>
          {saveError && <FieldError>{t("saveError")}</FieldError>}
          <Field orientation="horizontal">
            <FieldContent>
              <FieldLabel htmlFor={`${id}-namespaces`}>{t("namespaces.label")}</FieldLabel>
              <FieldDescription id={`${id}-namespaces-description`}>
                {t("namespaces.description")}
              </FieldDescription>
            </FieldContent>
            <Switch
              id={`${id}-namespaces`}
              aria-describedby={`${id}-namespaces-description ${id}-namespaces-warning`}
              checked={stored.allowNestedUserNamespaces === true}
              disabled={saving}
              onCheckedChange={(checked) => {
                void saveRuntime({ allowNestedUserNamespaces: checked })
              }}
            />
          </Field>
          <Alert role="note">
            <AlertDescription id={`${id}-namespaces-warning`}>
              {t("namespaces.warning")}
            </AlertDescription>
          </Alert>
          <Field orientation="horizontal">
            <FieldContent>
              <FieldLabel htmlFor={`${id}-retry`}>{t("retry.label")}</FieldLabel>
              <FieldDescription id={`${id}-retry-description`}>
                {t("retry.description")}
              </FieldDescription>
            </FieldContent>
            <Switch
              id={`${id}-retry`}
              aria-describedby={`${id}-retry-description ${id}-retry-availability`}
              checked={retryEnabled}
              disabled={saving}
              onCheckedChange={(enabled) => updateRetry({ enabled })}
            />
          </Field>
          <FieldDescription id={`${id}-retry-availability`}>
            {t("retry.availability")}
          </FieldDescription>
          {DURATION_FIELDS.map(([key, messageKey]) => (
            <Field key={key} data-disabled={!retryEnabled || saving} data-invalid={errors[key]}>
              <FieldLabel htmlFor={`${id}-${key}`}>{t(`${messageKey}.label`)}</FieldLabel>
              <Input
                key={`${key}-${minutes[key]}`}
                id={`${id}-${key}`}
                type="number"
                min={1}
                max={180}
                step={1}
                inputMode="numeric"
                disabled={!retryEnabled || saving}
                defaultValue={minutes[key]}
                aria-invalid={errors[key] || undefined}
                aria-describedby={`${id}-${key}-description${errors[key] ? ` ${id}-${key}-error` : ""}`}
                onChange={() => setErrors((current) => ({ ...current, [key]: false }))}
                onBlur={(event) => {
                  const value = Number(event.currentTarget.value)
                  if (validDuration(stored.unattendedRetry?.[key]) && value === minutes[key]) return
                  const valid = validMinutes(value)
                  setErrors((current) => ({ ...current, [key]: !valid }))
                  if (valid) updateRetry({ [key]: value * MINUTE_MS })
                }}
              />
              <FieldDescription id={`${id}-${key}-description`}>
                {t(`${messageKey}.description`)}
              </FieldDescription>
              {errors[key] && (
                <FieldError id={`${id}-${key}-error`}>{t("invalidMinutes")}</FieldError>
              )}
            </Field>
          ))}
          <FieldDescription>{t("retry.cancellation")}</FieldDescription>
        </FieldGroup>
      </CardContent>
    </Card>
  )
}
