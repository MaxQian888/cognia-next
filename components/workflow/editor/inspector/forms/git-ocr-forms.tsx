"use client"

/**
 * Per-kind inspector config forms for the Local Git workflow nodes
 * (`action.git.{stage,commit,push,branch}`, ADR-0038) and the OCR node
 * (`ocr.extract`, ADR-0024).
 *
 * Pattern mirrors the built-in forms in `./index.tsx` and `./github-forms.tsx`:
 * every form takes `params` + `onChange` and uses the shared
 * `Field`/`FieldGroup`/`patchParam` helpers. String fields that accept `{{ }}`
 * expressions use the `ExpressionField` component. The param shapes match
 * `lib/workflow/nodes/params-schemas.ts` and the executors in
 * `lib/workflow/nodes/{git,ocr}.ts`.
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

/** Read a string[]-typed param as a comma-separated editable string. */
function readStringList(params: Params, key: string): string {
  const v = params[key]
  if (!Array.isArray(v)) return ""
  return v.filter((x): x is string => typeof x === "string").join(", ")
}

/** Parse a comma-separated input into a trimmed, non-empty string[]. */
function parseStringList(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
}

// ── Reusable: repo path input (optional — defaults to the workspace root) ────

function RepoPathField({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.git.repoPath")
  return (
    <Field label={t("label")} htmlFor="git-repo" hint={t("hint")} name="repoPath">
      <ExpressionField
        id="git-repo"
        value={readString(params, "repoPath")}
        onChange={(v) => onChange(patchParam(params, "repoPath", v))}
        placeholder={t("placeholder")}
      />
    </Field>
  )
}

// ── action.git.stage ─────────────────────────────────────────────────────

export function GitStageConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.git.stage")
  return (
    <FieldGroup>
      <RepoPathField params={params} onChange={onChange} />
      <Field label={t("paths.label")} htmlFor="git-paths" hint={t("paths.hint")} name="paths">
        <Input
          id="git-paths"
          value={readStringList(params, "paths")}
          onChange={(e) => onChange(patchParam(params, "paths", parseStringList(e.target.value)))}
          placeholder={t("paths.placeholder")}
        />
      </Field>
    </FieldGroup>
  )
}

// ── action.git.commit ────────────────────────────────────────────────────

export function GitCommitConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.git.commit")
  return (
    <FieldGroup>
      <RepoPathField params={params} onChange={onChange} />
      <Field label={t("message.label")} name="message" required hint={t("message.hint")}>
        <ExpressionField
          value={readString(params, "message")}
          onChange={(v) => onChange(patchParam(params, "message", v))}
          placeholder={t("message.placeholder")}
        />
      </Field>
      <Field label={t("signoff.label")} name="signoff" hint={t("signoff.hint")}>
        <Switch
          checked={readBoolean(params, "signoff", false)}
          onCheckedChange={(b) => onChange(patchParam(params, "signoff", b))}
        />
      </Field>
    </FieldGroup>
  )
}

// ── action.git.push ──────────────────────────────────────────────────────

export function GitPushConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.git.push")
  return (
    <FieldGroup>
      <RepoPathField params={params} onChange={onChange} />
      <Field label={t("remote.label")} name="remote" hint={t("remote.hint")}>
        <ExpressionField
          value={readString(params, "remote")}
          onChange={(v) => onChange(patchParam(params, "remote", v))}
          placeholder={t("remote.placeholder")}
        />
      </Field>
      <Field label={t("branch.label")} name="branch" hint={t("branch.hint")}>
        <ExpressionField
          value={readString(params, "branch")}
          onChange={(v) => onChange(patchParam(params, "branch", v))}
          placeholder={t("branch.placeholder")}
        />
      </Field>
      <Field label={t("setUpstream.label")} name="setUpstream" hint={t("setUpstream.hint")}>
        <Switch
          checked={readBoolean(params, "setUpstream", false)}
          onCheckedChange={(b) => onChange(patchParam(params, "setUpstream", b))}
        />
      </Field>
    </FieldGroup>
  )
}

// ── action.git.branch ────────────────────────────────────────────────────

export function GitBranchConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.git.branch")
  return (
    <FieldGroup>
      <RepoPathField params={params} onChange={onChange} />
      <Field label={t("name.label")} name="name" required hint={t("name.hint")}>
        <ExpressionField
          value={readString(params, "name")}
          onChange={(v) => onChange(patchParam(params, "name", v))}
          placeholder={t("name.placeholder")}
        />
      </Field>
      <Field label={t("from.label")} name="from" hint={t("from.hint")}>
        <ExpressionField
          value={readString(params, "from")}
          onChange={(v) => onChange(patchParam(params, "from", v))}
          placeholder={t("from.placeholder")}
        />
      </Field>
      <Field label={t("checkout.label")} name="checkout" hint={t("checkout.hint")}>
        <Switch
          checked={readBoolean(params, "checkout", true)}
          onCheckedChange={(b) => onChange(patchParam(params, "checkout", b))}
        />
      </Field>
    </FieldGroup>
  )
}

// ── ocr.extract ──────────────────────────────────────────────────────────

const OCR_FORMATS = ["markdown", "text", "blocks"] as const

export function OcrExtractConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.ocr")
  const screen = readBoolean(params, "screen", false)
  const format = readString(params, "format", "markdown")
  return (
    <FieldGroup>
      <Field label={t("screen.label")} name="screen" hint={t("screen.hint")}>
        <Switch
          checked={screen}
          onCheckedChange={(b) => onChange(patchParam(params, "screen", b))}
        />
      </Field>
      {screen ? null : (
        <>
          <Field label={t("url.label")} name="url" hint={t("url.hint")}>
            <ExpressionField
              value={readString(params, "url")}
              onChange={(v) => onChange(patchParam(params, "url", v))}
              placeholder={t("url.placeholder")}
            />
          </Field>
          <Field label={t("dataUrl.label")} name="dataUrl" hint={t("dataUrl.hint")}>
            <ExpressionField
              value={readString(params, "dataUrl")}
              onChange={(v) => onChange(patchParam(params, "dataUrl", v))}
              placeholder={t("dataUrl.placeholder")}
            />
          </Field>
          <Field label={t("imageBase64.label")} name="imageBase64" hint={t("imageBase64.hint")}>
            <ExpressionField
              value={readString(params, "imageBase64")}
              onChange={(v) => onChange(patchParam(params, "imageBase64", v))}
              placeholder={t("imageBase64.placeholder")}
            />
          </Field>
          <Field
            label={t("pageRange.label")}
            htmlFor="ocr-pages"
            name="pageRange"
            hint={t("pageRange.hint")}
          >
            <Input
              id="ocr-pages"
              value={readString(params, "pageRange")}
              onChange={(e) => onChange(patchParam(params, "pageRange", e.target.value))}
              placeholder={t("pageRange.placeholder")}
            />
          </Field>
        </>
      )}
      <Field
        label={t("languages.label")}
        htmlFor="ocr-langs"
        name="languages"
        hint={t("languages.hint")}
      >
        <Input
          id="ocr-langs"
          value={readStringList(params, "languages")}
          onChange={(e) =>
            onChange(patchParam(params, "languages", parseStringList(e.target.value)))
          }
          placeholder={t("languages.placeholder")}
        />
      </Field>
      <Field
        label={t("provider.label")}
        htmlFor="ocr-provider"
        name="provider"
        hint={t("provider.hint")}
      >
        <Input
          id="ocr-provider"
          value={readString(params, "provider")}
          onChange={(e) => onChange(patchParam(params, "provider", e.target.value))}
          placeholder={t("provider.placeholder")}
        />
      </Field>
      <Field label={t("format.label")} name="format" hint={t("format.hint")}>
        <Select value={format} onValueChange={(v) => onChange(patchParam(params, "format", v))}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {OCR_FORMATS.map((f) => (
              <SelectItem key={f} value={f}>
                {t(`format.options.${f}`)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
    </FieldGroup>
  )
}
