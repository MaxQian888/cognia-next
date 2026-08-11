"use client"

/**
 * Inspector config form for the web-clone node (`io.webClone`).
 *
 * Mirrors the sibling forms (`git-ocr-forms.tsx`): every field uses the shared
 * `Field`/`FieldGroup`/`patchParam` helpers, and string fields that accept
 * `{{ }}` expressions use `ExpressionField`. The param shape matches
 * `WebCloneParams` in `lib/workflow/nodes/params-schemas.ts` and the executor in
 * `lib/workflow/nodes/automation/web-clone.ts`.
 */

import { useTranslations } from "next-intl"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Field, FieldGroup, patchParam, readBoolean, readString } from "./shared"
import { ExpressionField } from "./shared/expression-field"

type Params = Record<string, unknown>
type ChangeFn = (next: Params) => void

interface ConfigProps {
  params: Params
  onChange: ChangeFn
}

const MODES = ["bundle", "single"] as const
const FRAMEWORKS = ["vue", "react", "angular", "svelte", "jquery"] as const
const FRAMEWORK_HINTS = ["vue", "react", "svelte"] as const
const NONE = "__none__"

/** Read an optional numeric param as an editable string ("" when unset). */
function readOptionalNumber(params: Params, key: string): string {
  const v = params[key]
  return typeof v === "number" && Number.isFinite(v) ? String(v) : ""
}

/** Patch a numeric param, removing it when the input is cleared. */
function patchOptionalNumber(params: Params, key: string, raw: string): Params {
  const trimmed = raw.trim()
  if (trimmed === "") {
    const next = { ...params }
    delete next[key]
    return next
  }
  const n = Number(trimmed)
  return patchParam(params, key, Number.isFinite(n) ? n : undefined)
}

/** Patch an enum-ish param, removing it when the sentinel "none" is chosen. */
function patchEnum(params: Params, key: string, value: string): Params {
  if (value === NONE) {
    const next = { ...params }
    delete next[key]
    return next
  }
  return patchParam(params, key, value)
}

export function WebCloneConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.webClone")
  const mode = readString(params, "mode", "bundle")
  const framework = readString(params, "framework") || NONE
  const frameworkHint = readString(params, "frameworkHint") || NONE

  return (
    <FieldGroup>
      <Field label={t("url.label")} name="url" required hint={t("url.hint")}>
        <ExpressionField
          value={readString(params, "url")}
          onChange={(v) => onChange(patchParam(params, "url", v))}
          placeholder={t("url.placeholder")}
        />
      </Field>
      <Field label={t("output.label")} name="output" required hint={t("output.hint")}>
        <ExpressionField
          value={readString(params, "output")}
          onChange={(v) => onChange(patchParam(params, "output", v))}
          placeholder={t("output.placeholder")}
        />
      </Field>
      <Field label={t("mode.label")} name="mode" hint={t("mode.hint")}>
        <Select value={mode} onValueChange={(v) => onChange(patchParam(params, "mode", v))}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {MODES.map((m) => (
              <SelectItem key={m} value={m}>
                {t(`mode.options.${m}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field
        label={t("extractComponents.label")}
        name="extractComponents"
        hint={t("extractComponents.hint")}
      >
        <Switch
          checked={readBoolean(params, "extractComponents", false)}
          onCheckedChange={(b) => onChange(patchParam(params, "extractComponents", b))}
        />
      </Field>
      <Field label={t("framework.label")} name="framework" hint={t("framework.hint")}>
        <Select
          value={framework}
          onValueChange={(v) => onChange(patchEnum(params, "framework", v))}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>{t("framework.options.none")}</SelectItem>
            {FRAMEWORKS.map((f) => (
              <SelectItem key={f} value={f}>
                {t(`framework.options.${f}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field label={t("frameworkHint.label")} name="frameworkHint" hint={t("frameworkHint.hint")}>
        <Select
          value={frameworkHint}
          onValueChange={(v) => onChange(patchEnum(params, "frameworkHint", v))}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>{t("frameworkHint.options.none")}</SelectItem>
            {FRAMEWORK_HINTS.map((f) => (
              <SelectItem key={f} value={f}>
                {t(`frameworkHint.options.${f}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field
        label={t("maxAssets.label")}
        htmlFor="wc-max-assets"
        name="maxAssets"
        hint={t("maxAssets.hint")}
      >
        <Input
          id="wc-max-assets"
          type="number"
          value={readOptionalNumber(params, "maxAssets")}
          onChange={(e) => onChange(patchOptionalNumber(params, "maxAssets", e.target.value))}
          placeholder="100"
        />
      </Field>
      <Field
        label={t("concurrency.label")}
        htmlFor="wc-concurrency"
        name="concurrency"
        hint={t("concurrency.hint")}
      >
        <Input
          id="wc-concurrency"
          type="number"
          value={readOptionalNumber(params, "concurrency")}
          onChange={(e) => onChange(patchOptionalNumber(params, "concurrency", e.target.value))}
          placeholder="6"
        />
      </Field>
      <Field
        label={t("timeout.label")}
        htmlFor="wc-timeout"
        name="timeout"
        hint={t("timeout.hint")}
      >
        <Input
          id="wc-timeout"
          type="number"
          value={readOptionalNumber(params, "timeout")}
          onChange={(e) => onChange(patchOptionalNumber(params, "timeout", e.target.value))}
          placeholder="15000"
        />
      </Field>
      <Field
        label={t("maxFileSize.label")}
        htmlFor="wc-max-file"
        name="maxFileSize"
        hint={t("maxFileSize.hint")}
      >
        <Input
          id="wc-max-file"
          type="number"
          value={readOptionalNumber(params, "maxFileSize")}
          onChange={(e) => onChange(patchOptionalNumber(params, "maxFileSize", e.target.value))}
          placeholder="52428800"
        />
      </Field>
      <Field label={t("pretty.label")} name="pretty" hint={t("pretty.hint")}>
        <Switch
          checked={readBoolean(params, "pretty", false)}
          onCheckedChange={(b) => onChange(patchParam(params, "pretty", b))}
        />
      </Field>
      <Field
        label={t("allowPrivateHosts.label")}
        name="allowPrivateHosts"
        hint={t("allowPrivateHosts.hint")}
      >
        <Switch
          checked={readBoolean(params, "allowPrivateHosts", false)}
          onCheckedChange={(b) => onChange(patchParam(params, "allowPrivateHosts", b))}
        />
      </Field>
    </FieldGroup>
  )
}
