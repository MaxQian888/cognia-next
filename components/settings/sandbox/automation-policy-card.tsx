// ADR-0028 Phase 9 / T5 — per-action policy editor.
//
// Four list editors, each backed by an array on `AutomationPolicy`. Edits
// debounce-save via `saveAutomationPolicy` so the next Computer Use call
// sees the new constraints without a restart. Regex fields validate on
// blur (the dispatcher treats unparseable patterns as deny, so highlight
// them early).

"use client"

import { Plus, Trash2 } from "lucide-react"
import { useEffect, useId, useMemo, useState } from "react"
import { useTranslations } from "next-intl"

import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { cn } from "@/lib/utils"

import { getAutomationPolicy, saveAutomationPolicy } from "@/lib/automation/policy"
import {
  DEFAULT_AUTOMATION_POLICY,
  type AutomationPolicy,
  type ScreenRect,
} from "@cognia/agent-config-types"

/**
 * Save debounce. Edits land in Rust + Dexie after 400ms of quiet so
 * typing doesn't fire dozens of IPC calls.
 */
const SAVE_DEBOUNCE_MS = 400

function isValidRegex(pattern: string): boolean {
  if (pattern.length === 0) return true
  try {
    new RegExp(pattern)
    return true
  } catch {
    return false
  }
}

function clonePolicy(p: AutomationPolicy): AutomationPolicy {
  return {
    allowedProcessNames: [...p.allowedProcessNames],
    allowedWindowTitlePatterns: [...p.allowedWindowTitlePatterns],
    allowedUrlPatterns: [...p.allowedUrlPatterns],
    forbiddenScreenRegions: p.forbiddenScreenRegions.map((r) => ({ ...r })),
  }
}

export function AutomationPolicyCard() {
  const t = useTranslations("settings.sandbox.automationPolicy")
  const [policy, setPolicy] = useState<AutomationPolicy>(DEFAULT_AUTOMATION_POLICY)
  const [loaded, setLoaded] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  // Hydrate once from Rust state. The renderer is the source of truth
  // for Dexie, but Rust state may be ahead (e.g. another tab edited it),
  // so prefer Rust-side on first read.
  useEffect(() => {
    let cancelled = false
    void getAutomationPolicy()
      .then((p) => {
        if (cancelled) return
        setPolicy(p)
        setLoaded(true)
      })
      .catch(() => {
        if (cancelled) return
        setPolicy(DEFAULT_AUTOMATION_POLICY)
        setLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  // Debounced persistence. Skips before the initial hydrate to avoid
  // overwriting Rust state with the empty default during boot.
  useEffect(() => {
    if (!loaded) return
    const handle = setTimeout(() => {
      void saveAutomationPolicy(policy)
        .then(() => setSaveError(null))
        .catch((err: unknown) => {
          setSaveError(err instanceof Error ? err.message : String(err))
        })
    }, SAVE_DEBOUNCE_MS)
    return () => clearTimeout(handle)
  }, [policy, loaded])

  const isEmpty = useMemo(
    () =>
      policy.allowedProcessNames.length === 0 &&
      policy.allowedWindowTitlePatterns.length === 0 &&
      policy.allowedUrlPatterns.length === 0 &&
      policy.forbiddenScreenRegions.length === 0,
    [policy]
  )

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <CardDescription>{t("description")}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-6 text-sm">
        {isEmpty && (
          <p className="text-muted-foreground" data-testid="policy-empty-note">
            {t("emptyNote")}
          </p>
        )}

        <StringListEditor
          label={t("allowedProcessNames.label")}
          description={t("allowedProcessNames.description")}
          placeholder={t("allowedProcessNames.placeholder")}
          values={policy.allowedProcessNames}
          validate={() => true}
          testId="policy-process-names"
          onChange={(values) =>
            setPolicy((prev) => clonePolicy({ ...prev, allowedProcessNames: values }))
          }
        />

        <StringListEditor
          label={t("allowedWindowTitlePatterns.label")}
          description={t("allowedWindowTitlePatterns.description")}
          placeholder={t("allowedWindowTitlePatterns.placeholder")}
          values={policy.allowedWindowTitlePatterns}
          validate={isValidRegex}
          invalidMessage={t("regexInvalid")}
          testId="policy-window-titles"
          onChange={(values) =>
            setPolicy((prev) => clonePolicy({ ...prev, allowedWindowTitlePatterns: values }))
          }
        />

        <StringListEditor
          label={t("allowedUrlPatterns.label")}
          description={t("allowedUrlPatterns.description")}
          placeholder={t("allowedUrlPatterns.placeholder")}
          values={policy.allowedUrlPatterns}
          validate={isValidRegex}
          invalidMessage={t("regexInvalid")}
          testId="policy-url-patterns"
          onChange={(values) =>
            setPolicy((prev) => clonePolicy({ ...prev, allowedUrlPatterns: values }))
          }
        />

        <ScreenRegionEditor
          label={t("forbiddenScreenRegions.label")}
          description={t("forbiddenScreenRegions.description")}
          rects={policy.forbiddenScreenRegions}
          onChange={(rects) =>
            setPolicy((prev) => clonePolicy({ ...prev, forbiddenScreenRegions: rects }))
          }
          axisLabels={{
            x: t("forbiddenScreenRegions.x"),
            y: t("forbiddenScreenRegions.y"),
            width: t("forbiddenScreenRegions.width"),
            height: t("forbiddenScreenRegions.height"),
          }}
        />

        {saveError && (
          <p className="text-xs text-rose-500" role="alert" data-testid="policy-save-error">
            {t("saveError", { error: saveError })}
          </p>
        )}
      </CardContent>
    </Card>
  )
}

interface StringListEditorProps {
  label: string
  description: string
  placeholder: string
  values: string[]
  validate: (value: string) => boolean
  invalidMessage?: string
  testId: string
  onChange(values: string[]): void
}

function StringListEditor({
  label,
  description,
  placeholder,
  values,
  validate,
  invalidMessage,
  testId,
  onChange,
}: StringListEditorProps) {
  const t = useTranslations("settings.sandbox.automationPolicy")
  const groupId = useId()

  return (
    <fieldset className="space-y-2" data-testid={testId}>
      <legend className="font-medium" id={groupId}>
        {label}
      </legend>
      <p className="text-xs text-muted-foreground">{description}</p>
      <ul className="space-y-2" aria-labelledby={groupId}>
        {values.map((value, idx) => {
          const valid = validate(value)
          return (
            <li key={idx} className="flex items-center gap-2">
              <Input
                value={value}
                placeholder={placeholder}
                aria-invalid={!valid}
                aria-label={t("rowAriaLabel", { label, index: idx + 1 })}
                onChange={(event) => {
                  const next = [...values]
                  next[idx] = event.target.value
                  onChange(next)
                }}
                className={cn(!valid && "border-rose-500")}
              />
              <Button
                variant="ghost"
                size="icon"
                aria-label={t("remove")}
                onClick={() => {
                  const next = values.filter((_, i) => i !== idx)
                  onChange(next)
                }}
              >
                <Trash2 className="size-4" aria-hidden="true" />
              </Button>
              {!valid && invalidMessage && (
                <span className="text-xs text-rose-500">{invalidMessage}</span>
              )}
            </li>
          )
        })}
      </ul>
      <Button
        variant="outline"
        size="sm"
        onClick={() => onChange([...values, ""])}
        data-testid={`${testId}-add`}
      >
        <Plus className="size-4" aria-hidden="true" />
        {t("add")}
      </Button>
    </fieldset>
  )
}

interface ScreenRegionEditorProps {
  label: string
  description: string
  rects: ScreenRect[]
  axisLabels: { x: string; y: string; width: string; height: string }
  onChange(rects: ScreenRect[]): void
}

function ScreenRegionEditor({
  label,
  description,
  rects,
  axisLabels,
  onChange,
}: ScreenRegionEditorProps) {
  const t = useTranslations("settings.sandbox.automationPolicy")
  const groupId = useId()

  return (
    <fieldset className="space-y-2" data-testid="policy-screen-regions">
      <legend className="font-medium" id={groupId}>
        {label}
      </legend>
      <p className="text-xs text-muted-foreground">{description}</p>
      <ul className="space-y-3" aria-labelledby={groupId}>
        {rects.map((rect, idx) => (
          <li key={idx} className="flex flex-wrap items-end gap-2 rounded-md border p-2">
            <ScreenCoordInput
              label={axisLabels.x}
              value={rect.x}
              onChange={(value) => {
                const next = rects.map((r, i) => (i === idx ? { ...r, x: value } : r))
                onChange(next)
              }}
            />
            <ScreenCoordInput
              label={axisLabels.y}
              value={rect.y}
              onChange={(value) => {
                const next = rects.map((r, i) => (i === idx ? { ...r, y: value } : r))
                onChange(next)
              }}
            />
            <ScreenCoordInput
              label={axisLabels.width}
              value={rect.width}
              onChange={(value) => {
                const next = rects.map((r, i) => (i === idx ? { ...r, width: value } : r))
                onChange(next)
              }}
            />
            <ScreenCoordInput
              label={axisLabels.height}
              value={rect.height}
              onChange={(value) => {
                const next = rects.map((r, i) => (i === idx ? { ...r, height: value } : r))
                onChange(next)
              }}
            />
            <Button
              variant="ghost"
              size="icon"
              aria-label={t("remove")}
              onClick={() => onChange(rects.filter((_, i) => i !== idx))}
            >
              <Trash2 className="size-4" aria-hidden="true" />
            </Button>
          </li>
        ))}
      </ul>
      <Button
        variant="outline"
        size="sm"
        onClick={() => onChange([...rects, { x: 0, y: 0, width: 0, height: 0 }])}
        data-testid="policy-screen-regions-add"
      >
        <Plus className="size-4" aria-hidden="true" />
        {t("add")}
      </Button>
    </fieldset>
  )
}

interface ScreenCoordInputProps {
  label: string
  value: number
  onChange(value: number): void
}

function ScreenCoordInput({ label, value, onChange }: ScreenCoordInputProps) {
  const id = useId()
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id} className="text-xs text-muted-foreground">
        {label}
      </Label>
      <Input
        id={id}
        type="number"
        inputMode="numeric"
        defaultValue={value}
        className="w-20"
        onBlur={(event) => {
          const parsed = Number.parseInt(event.target.value, 10)
          onChange(Number.isFinite(parsed) ? parsed : 0)
        }}
      />
    </div>
  )
}
