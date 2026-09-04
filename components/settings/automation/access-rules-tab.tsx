"use client"

/**
 * Settings then Automation then Access rules.
 *
 * One editor for what used to be two, in two different Settings sections that
 * never mentioned each other: the global whitelist here, and the per-action
 * policy under Settings then Sandbox. Both gate the same Rust dispatch, so a
 * user who allowed a process in one had no way to know the other was still
 * refusing it.
 *
 * They are not the same gate, which is why this renders two labelled stages
 * rather than one merged list. `lib/automation/access-rules.ts` carries the
 * exact semantics. The short version, which the copy also states:
 *
 * - Stage 1 admits. Empty admits everything, any single match admits.
 * - Stage 2 restricts, after consent, Computer Use only. Every filled list
 *   must match, and the patterns are regular expressions rather than globs.
 */

import { useCallback, useEffect, useId, useState } from "react"
import { useTranslations } from "next-intl"
import { CrosshairIcon, PlusIcon, Trash2Icon, TrashIcon } from "lucide-react"
import { toast } from "sonner"

import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { Skeleton } from "@/components/ui/skeleton"
import { cn } from "@/lib/utils"
import { isTauri } from "@/lib/tauri"
import type { ScreenRect } from "@cognia/agent-config-types"
import {
  captureFocusedTarget,
  defaultAutomationAccessRules,
  getAutomationAccessRules,
  isAdmitEmpty,
  saveAutomationAccessRules,
  type AutomationAccessRules,
} from "@/lib/automation/access-rules"

import { AutomationUnavailableNotice } from "./automation-unavailable-notice"

/** Edits land in Rust after this much quiet, so typing is not one IPC per key. */
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

export function AccessRulesTab() {
  const t = useTranslations("automation.accessRules")
  const [rules, setRules] = useState<AutomationAccessRules>(defaultAutomationAccessRules)
  const [loaded, setLoaded] = useState(() => !isTauri())
  const [saveError, setSaveError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [focus, setFocus] = useState<{
    processName: string | null
    windowTitle: string | null
  } | null>(null)
  const [processInput, setProcessInput] = useState("")
  const [titleInput, setTitleInput] = useState("")

  useEffect(() => {
    if (!isTauri()) return
    let cancelled = false
    getAutomationAccessRules()
      .then((next) => {
        if (cancelled) return
        setRules(next)
      })
      .catch((err) => {
        if (cancelled) return
        setSaveError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  /**
   * Every edit goes through here so the "saving" flag is raised in the event
   * that caused it. Raising it inside the persist effect instead would be a
   * synchronous setState in an effect body, which cascades a render.
   */
  const updateRules = useCallback(
    (next: (prev: AutomationAccessRules) => AutomationAccessRules) => {
      setRules(next)
      setSaving(true)
    },
    []
  )

  // Persist on a trailing debounce. Skipped until the first read lands so the
  // defaults this component starts with never overwrite what the host holds.
  useEffect(() => {
    if (!loaded || !saving || !isTauri()) return
    const handle = window.setTimeout(() => {
      saveAutomationAccessRules(rules)
        .then(() => setSaveError(null))
        .catch((err) => setSaveError(err instanceof Error ? err.message : String(err)))
        .finally(() => setSaving(false))
    }, SAVE_DEBOUNCE_MS)
    return () => window.clearTimeout(handle)
  }, [rules, loaded, saving])

  const captureFocus = useCallback(async () => {
    try {
      const next = await captureFocusedTarget()
      setFocus(next)
      setProcessInput((current) => current || (next.processName ?? ""))
      setTitleInput((current) => current || (next.windowTitle ?? ""))
    } catch (err) {
      toast.error(t("admit.captureFailed"), {
        description: err instanceof Error ? err.message : String(err),
      })
    }
  }, [t])

  if (!isTauri()) return <AutomationUnavailableNotice />
  if (!loaded) return <Skeleton className="h-96 w-full" />

  const addAdmitProcess = () => {
    const value = processInput.trim()
    if (!value) return
    if (rules.admit.processNames.includes(value)) {
      toast.info(t("admit.duplicate"))
      return
    }
    updateRules((prev) => ({
      ...prev,
      admit: { ...prev.admit, processNames: [...prev.admit.processNames, value] },
    }))
    setProcessInput("")
  }

  const addAdmitTitle = () => {
    const value = titleInput.trim()
    if (!value) return
    if (rules.admit.windowTitlePatterns.includes(value)) {
      toast.info(t("admit.duplicate"))
      return
    }
    updateRules((prev) => ({
      ...prev,
      admit: {
        ...prev.admit,
        windowTitlePatterns: [...prev.admit.windowTitlePatterns, value],
      },
    }))
    setTitleInput("")
  }

  const removeAdmitProcess = (name: string) =>
    updateRules((prev) => ({
      ...prev,
      admit: {
        ...prev.admit,
        processNames: prev.admit.processNames.filter((p) => p !== name),
      },
    }))

  const removeAdmitTitle = (pattern: string) =>
    updateRules((prev) => ({
      ...prev,
      admit: {
        ...prev.admit,
        windowTitlePatterns: prev.admit.windowTitlePatterns.filter((p) => p !== pattern),
      },
    }))

  return (
    <div className="space-y-4" data-testid="automation-access-rules">
      <Card>
        <CardHeader>
          <CardTitle className="flex flex-wrap items-center gap-2">
            <span>{t("title")}</span>
            {saving && (
              <Badge variant="outline" className="text-[10px]" data-testid="access-rules-saving">
                {t("saving")}
              </Badge>
            )}
          </CardTitle>
          <CardDescription>{t("description")}</CardDescription>
        </CardHeader>
        <CardContent>
          <Alert>
            <AlertDescription className="text-xs">{t("hardBoundaryNote")}</AlertDescription>
          </Alert>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("stageAdmitTitle")}</CardTitle>
          <CardDescription>{t("stageAdmitDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5 text-sm">
          {isAdmitEmpty(rules.admit) && (
            <p className="text-xs text-muted-foreground" data-testid="admit-empty-note">
              {t("admit.emptyNote")}
            </p>
          )}

          <div className="space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => void captureFocus()}>
                <CrosshairIcon className="size-4" aria-hidden="true" />
                {t("admit.captureFocused")}
              </Button>
              {focus && (
                <span className="min-w-0 truncate text-xs text-muted-foreground">
                  {focus.processName ?? t("admit.none")} · {focus.windowTitle ?? t("admit.none")}
                </span>
              )}
            </div>
          </div>

          <BadgeListEditor
            label={t("admit.processNames")}
            description={t("admit.processNamesHint")}
            placeholder={t("admit.processPlaceholder")}
            addLabel={t("admit.add")}
            removeAriaFor={(entry) => t("admit.removeEntryAria", { entry })}
            emptyLabel={t("admit.emptyProcess")}
            value={processInput}
            onValueChange={setProcessInput}
            onAdd={addAdmitProcess}
            entries={rules.admit.processNames}
            onRemove={removeAdmitProcess}
            testId="admit-process-names"
          />

          <BadgeListEditor
            label={t("admit.windowTitles")}
            description={t("admit.windowTitlesHint")}
            placeholder={t("admit.windowPlaceholder")}
            addLabel={t("admit.add")}
            removeAriaFor={(entry) => t("admit.removeEntryAria", { entry })}
            emptyLabel={t("admit.emptyWindow")}
            value={titleInput}
            onValueChange={setTitleInput}
            onAdd={addAdmitTitle}
            entries={rules.admit.windowTitlePatterns}
            onRemove={removeAdmitTitle}
            testId="admit-window-titles"
          />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("stageRestrictTitle")}</CardTitle>
          <CardDescription>{t("stageRestrictDescription")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-6 text-sm">
          <StringListEditor
            label={t("restrict.allowedProcessNames.label")}
            description={t("restrict.allowedProcessNames.description")}
            placeholder={t("restrict.allowedProcessNames.placeholder")}
            values={rules.restrict.allowedProcessNames}
            validate={() => true}
            testId="restrict-process-names"
            onChange={(values) =>
              updateRules((prev) => ({
                ...prev,
                restrict: { ...prev.restrict, allowedProcessNames: values },
              }))
            }
          />

          <StringListEditor
            label={t("restrict.allowedWindowTitlePatterns.label")}
            description={t("restrict.allowedWindowTitlePatterns.description")}
            placeholder={t("restrict.allowedWindowTitlePatterns.placeholder")}
            values={rules.restrict.allowedWindowTitlePatterns}
            validate={isValidRegex}
            invalidMessage={t("restrict.regexInvalid")}
            testId="restrict-window-titles"
            onChange={(values) =>
              updateRules((prev) => ({
                ...prev,
                restrict: { ...prev.restrict, allowedWindowTitlePatterns: values },
              }))
            }
          />

          <StringListEditor
            label={t("restrict.allowedUrlPatterns.label")}
            description={t("restrict.allowedUrlPatterns.description")}
            placeholder={t("restrict.allowedUrlPatterns.placeholder")}
            values={rules.restrict.allowedUrlPatterns}
            validate={isValidRegex}
            invalidMessage={t("restrict.regexInvalid")}
            testId="restrict-url-patterns"
            onChange={(values) =>
              updateRules((prev) => ({
                ...prev,
                restrict: { ...prev.restrict, allowedUrlPatterns: values },
              }))
            }
          />

          <ScreenRegionEditor
            label={t("restrict.forbiddenScreenRegions.label")}
            description={t("restrict.forbiddenScreenRegions.description")}
            removeLabel={t("restrict.remove")}
            addLabel={t("restrict.add")}
            rects={rules.restrict.forbiddenScreenRegions}
            axisLabels={{
              x: t("restrict.forbiddenScreenRegions.x"),
              y: t("restrict.forbiddenScreenRegions.y"),
              width: t("restrict.forbiddenScreenRegions.width"),
              height: t("restrict.forbiddenScreenRegions.height"),
            }}
            onChange={(rects) =>
              updateRules((prev) => ({
                ...prev,
                restrict: { ...prev.restrict, forbiddenScreenRegions: rects },
              }))
            }
          />
        </CardContent>
      </Card>

      {saveError && (
        <p className="text-xs text-rose-500" role="alert" data-testid="access-rules-save-error">
          {t("restrict.saveError", { error: saveError })}
        </p>
      )}
    </div>
  )
}

interface BadgeListEditorProps {
  label: string
  description: string
  placeholder: string
  addLabel: string
  removeAriaFor: (entry: string) => string
  emptyLabel: string
  value: string
  onValueChange: (value: string) => void
  onAdd: () => void
  entries: string[]
  onRemove: (entry: string) => void
  testId: string
}

/**
 * The admit-stage list. Entries are whole values rather than editable rows,
 * because a half-typed process name in this stage silently stops admitting the
 * app it was meant to name.
 */
function BadgeListEditor({
  label,
  description,
  placeholder,
  addLabel,
  removeAriaFor,
  emptyLabel,
  value,
  onValueChange,
  onAdd,
  entries,
  onRemove,
  testId,
}: BadgeListEditorProps) {
  const inputId = useId()

  return (
    <div className="space-y-2" data-testid={testId}>
      <Label htmlFor={inputId} className="font-medium">
        {label}
      </Label>
      <p className="text-xs text-muted-foreground">{description}</p>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input
          id={inputId}
          value={value}
          placeholder={placeholder}
          className="min-w-0 flex-1"
          onChange={(event) => onValueChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return
            event.preventDefault()
            onAdd()
          }}
        />
        <Button variant="outline" size="sm" onClick={onAdd} className="sm:w-auto">
          <PlusIcon className="size-4" aria-hidden="true" />
          {addLabel}
        </Button>
      </div>
      {entries.length === 0 ? (
        <p className="text-xs text-muted-foreground">{emptyLabel}</p>
      ) : (
        <div className="flex flex-wrap gap-2">
          {entries.map((entry) => (
            <Badge key={entry} variant="secondary" className="max-w-full gap-1 font-mono text-xs">
              <span className="min-w-0 truncate">{entry}</span>
              <button
                type="button"
                aria-label={removeAriaFor(entry)}
                onClick={() => onRemove(entry)}
                className="shrink-0 opacity-60 hover:opacity-100"
              >
                <TrashIcon className="size-3" aria-hidden="true" />
              </button>
            </Badge>
          ))}
        </div>
      )}
    </div>
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
  onChange: (values: string[]) => void
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
  const t = useTranslations("automation.accessRules.restrict")
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
            <li key={idx} className="flex flex-wrap items-center gap-2">
              <Input
                value={value}
                placeholder={placeholder}
                aria-invalid={!valid}
                aria-label={t("rowAriaLabel", { label, index: idx + 1 })}
                className={cn("min-w-0 flex-1", !valid && "border-rose-500")}
                onChange={(event) => {
                  const next = [...values]
                  next[idx] = event.target.value
                  onChange(next)
                }}
              />
              <Button
                variant="ghost"
                size="icon"
                aria-label={t("remove")}
                className="shrink-0"
                onClick={() => onChange(values.filter((_, i) => i !== idx))}
              >
                <Trash2Icon className="size-4" aria-hidden="true" />
              </Button>
              {!valid && invalidMessage && (
                <span className="w-full text-xs text-rose-500">{invalidMessage}</span>
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
        <PlusIcon className="size-4" aria-hidden="true" />
        {t("add")}
      </Button>
    </fieldset>
  )
}

interface ScreenRegionEditorProps {
  label: string
  description: string
  addLabel: string
  removeLabel: string
  rects: ScreenRect[]
  axisLabels: { x: string; y: string; width: string; height: string }
  onChange: (rects: ScreenRect[]) => void
}

function ScreenRegionEditor({
  label,
  description,
  addLabel,
  removeLabel,
  rects,
  axisLabels,
  onChange,
}: ScreenRegionEditorProps) {
  const groupId = useId()

  return (
    <fieldset className="space-y-2" data-testid="restrict-screen-regions">
      <legend className="font-medium" id={groupId}>
        {label}
      </legend>
      <p className="text-xs text-muted-foreground">{description}</p>
      <ul className="space-y-3" aria-labelledby={groupId}>
        {rects.map((rect, idx) => (
          <li key={idx} className="flex flex-wrap items-end gap-2 rounded-md border p-2">
            {(["x", "y", "width", "height"] as const).map((axis) => (
              <ScreenCoordInput
                key={axis}
                label={axisLabels[axis]}
                value={rect[axis]}
                onChange={(value) =>
                  onChange(rects.map((r, i) => (i === idx ? { ...r, [axis]: value } : r)))
                }
              />
            ))}
            <Button
              variant="ghost"
              size="icon"
              aria-label={removeLabel}
              className="shrink-0"
              onClick={() => onChange(rects.filter((_, i) => i !== idx))}
            >
              <Trash2Icon className="size-4" aria-hidden="true" />
            </Button>
          </li>
        ))}
      </ul>
      <Button
        variant="outline"
        size="sm"
        onClick={() => onChange([...rects, { x: 0, y: 0, width: 0, height: 0 }])}
        data-testid="restrict-screen-regions-add"
      >
        <PlusIcon className="size-4" aria-hidden="true" />
        {addLabel}
      </Button>
    </fieldset>
  )
}

function ScreenCoordInput({
  label,
  value,
  onChange,
}: {
  label: string
  value: number
  onChange: (value: number) => void
}) {
  const id = useId()
  return (
    <div className="flex min-w-0 flex-col gap-1">
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
