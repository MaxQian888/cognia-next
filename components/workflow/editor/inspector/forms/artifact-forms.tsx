"use client"

/**
 * Per-kind inspector config forms for the Artifact + Canvas workflow nodes
 * (`action.artifact.{create,update,get,export}`, `action.canvas.{create,get}`).
 *
 * Same pattern as `./site-forms.tsx`: `params` + `onChange`, the shared
 * `Field`/`FieldGroup`/`patchParam` helpers, and `ExpressionField` wherever a
 * value can be a `{{ }}` expression — which every text field here can, because
 * the usual flow is "an agent step produced this, now save it".
 *
 * `type` and `format` are the exceptions: they are closed enums that
 * `params-schemas.ts` validates, so a free-text expression there would fail at
 * run time with no way for the author to see it coming.
 *
 * Param shapes match `lib/workflow/nodes/params-schemas.ts` and the executors
 * in `lib/workflow/nodes/artifacts/index.ts`.
 */

import { useTranslations } from "next-intl"

import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { Field, FieldGroup, patchParam, readString } from "./shared"
import { ExpressionField } from "./shared/expression-field"
import { ARTIFACT_TYPES } from "@/lib/artifacts/constants"

type Params = Record<string, unknown>
interface ConfigProps {
  params: Params
  onChange: (next: Params) => void
}

const EXPORT_FORMATS = ["raw", "html", "svg", "png", "pdf"] as const

/**
 * Which conversation the row belongs to. Optional everywhere: a scheduled or
 * webhook-triggered flow has no conversation, and an empty value is the honest
 * answer rather than parking the artifact in someone else's dock.
 */
function SessionIdField({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.artifact")
  return (
    <Field label={t("sessionId.label")} name="sessionId" hint={t("sessionId.hint")}>
      <ExpressionField
        value={readString(params, "sessionId")}
        onChange={(value) => onChange(patchParam(params, "sessionId", value))}
        // i18n-exempt: an expression example, not prose
        placeholder="{{ $trigger.sessionId }}"
      />
    </Field>
  )
}

function ContentField({
  params,
  onChange,
  label,
  hint,
  required,
}: ConfigProps & { label: string; hint: string; required?: boolean }) {
  return (
    <Field label={label} name="content" hint={hint} required={required}>
      <Textarea
        id="content"
        rows={6}
        value={readString(params, "content")}
        onChange={(event) => onChange(patchParam(params, "content", event.target.value))}
        // i18n-exempt: an expression example, not prose
        placeholder="{{ $node['agent'].text }}"
      />
    </Field>
  )
}

export function ArtifactCreateConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.artifact")
  const type = readString(params, "type")
  return (
    <FieldGroup>
      <Field label={t("title.label")} name="title" required hint={t("title.hint")}>
        <ExpressionField
          value={readString(params, "title")}
          onChange={(value) => onChange(patchParam(params, "title", value))}
          placeholder={t("title.placeholder")}
        />
      </Field>
      <Field label={t("type.label")} name="type" required hint={t("type.hint")}>
        <Select value={type} onValueChange={(v) => onChange(patchParam(params, "type", v))}>
          <SelectTrigger id="type">
            <SelectValue placeholder={t("type.placeholder")} />
          </SelectTrigger>
          <SelectContent>
            {ARTIFACT_TYPES.map((value) => (
              // i18n-exempt: the artifact type vocabulary, shown verbatim
              // everywhere else in the dock too
              <SelectItem key={value} value={value}>
                {value}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <ContentField
        params={params}
        onChange={onChange}
        label={t("content.label")}
        hint={t("content.hint")}
        required
      />
      <Field label={t("language.label")} name="language" hint={t("language.hint")}>
        <ExpressionField
          value={readString(params, "language")}
          onChange={(value) => onChange(patchParam(params, "language", value))}
          // i18n-exempt: a language identifier, not prose
          placeholder="typescript"
        />
      </Field>
      {type === "chart" ? (
        <Field label={t("chartType.label")} name="chartType" hint={t("chartType.hint")}>
          <ExpressionField
            value={readString(params, "chartType")}
            onChange={(value) => onChange(patchParam(params, "chartType", value))}
            // i18n-exempt: a chart-type identifier, not prose
            placeholder="bar"
          />
        </Field>
      ) : null}
      <SessionIdField params={params} onChange={onChange} />
    </FieldGroup>
  )
}

export function ArtifactUpdateConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.artifact")
  return (
    <FieldGroup>
      <Field label={t("artifactId.label")} name="artifactId" required hint={t("artifactId.hint")}>
        <ExpressionField
          value={readString(params, "artifactId")}
          onChange={(value) => onChange(patchParam(params, "artifactId", value))}
          // i18n-exempt: an expression example, not prose
          placeholder="{{ $node['create'].artifactId }}"
        />
      </Field>
      <ContentField
        params={params}
        onChange={onChange}
        label={t("content.label")}
        hint={t("newContent.hint")}
        required
      />
      <Field label={t("title.label")} name="title" hint={t("renameTitle.hint")}>
        <ExpressionField
          value={readString(params, "title")}
          onChange={(value) => onChange(patchParam(params, "title", value))}
          placeholder={t("title.placeholder")}
        />
      </Field>
      <Field
        label={t("changeDescription.label")}
        name="changeDescription"
        hint={t("changeDescription.hint")}
      >
        <ExpressionField
          value={readString(params, "changeDescription")}
          onChange={(value) => onChange(patchParam(params, "changeDescription", value))}
          placeholder={t("changeDescription.placeholder")}
        />
      </Field>
    </FieldGroup>
  )
}

export function ArtifactGetConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.artifact")
  return (
    <FieldGroup>
      <Field label={t("artifactId.label")} name="artifactId" hint={t("readArtifactId.hint")}>
        <ExpressionField
          value={readString(params, "artifactId")}
          onChange={(value) => onChange(patchParam(params, "artifactId", value))}
          // i18n-exempt: an expression example, not prose
          placeholder="{{ $node['create'].artifactId }}"
        />
      </Field>
      <Field label={t("query.label")} name="query" hint={t("query.hint")}>
        <ExpressionField
          value={readString(params, "query")}
          onChange={(value) => onChange(patchParam(params, "query", value))}
          placeholder={t("query.placeholder")}
        />
      </Field>
      <SessionIdField params={params} onChange={onChange} />
    </FieldGroup>
  )
}

export function ArtifactExportConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.artifact")
  return (
    <FieldGroup>
      <Field label={t("artifactId.label")} name="artifactId" required hint={t("artifactId.hint")}>
        <ExpressionField
          value={readString(params, "artifactId")}
          onChange={(value) => onChange(patchParam(params, "artifactId", value))}
          // i18n-exempt: an expression example, not prose
          placeholder="{{ $node['create'].artifactId }}"
        />
      </Field>
      <Field label={t("format.label")} name="format" hint={t("format.hint")}>
        <Select
          value={readString(params, "format") || "raw"}
          onValueChange={(v) => onChange(patchParam(params, "format", v))}
        >
          <SelectTrigger id="format">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {EXPORT_FORMATS.map((value) => (
              // i18n-exempt: file-format identifiers, not prose
              <SelectItem key={value} value={value}>
                {value}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
    </FieldGroup>
  )
}

export function CanvasCreateConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.artifact")
  return (
    <FieldGroup>
      <Field label={t("title.label")} name="title" required hint={t("canvasTitle.hint")}>
        <ExpressionField
          value={readString(params, "title")}
          onChange={(value) => onChange(patchParam(params, "title", value))}
          placeholder={t("title.placeholder")}
        />
      </Field>
      <Field label={t("language.label")} name="language" required hint={t("canvasLanguage.hint")}>
        <ExpressionField
          value={readString(params, "language")}
          onChange={(value) => onChange(patchParam(params, "language", value))}
          // i18n-exempt: a language identifier, not prose
          placeholder="typescript"
        />
      </Field>
      <ContentField
        params={params}
        onChange={onChange}
        label={t("content.label")}
        hint={t("canvasContent.hint")}
      />
      <Field label={t("docType.label")} name="type" hint={t("docType.hint")}>
        <Select
          value={readString(params, "type") || "code"}
          onValueChange={(v) => onChange(patchParam(params, "type", v))}
        >
          <SelectTrigger id="type">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="code">{t("docType.code")}</SelectItem>
            <SelectItem value="text">{t("docType.text")}</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      <SessionIdField params={params} onChange={onChange} />
    </FieldGroup>
  )
}

export function CanvasGetConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.artifact")
  return (
    <FieldGroup>
      <Field label={t("documentId.label")} name="documentId" hint={t("documentId.hint")}>
        <ExpressionField
          value={readString(params, "documentId")}
          onChange={(value) => onChange(patchParam(params, "documentId", value))}
          // i18n-exempt: an expression example, not prose
          placeholder="{{ $node['create'].documentId }}"
        />
      </Field>
      <SessionIdField params={params} onChange={onChange} />
    </FieldGroup>
  )
}
