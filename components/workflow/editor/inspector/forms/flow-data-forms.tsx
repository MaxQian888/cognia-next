"use client"

/**
 * Per-kind inspector config forms. Co-located in one file because each form
 * is small (5–20 lines of fields) and they all share the same shape — the
 * registry imports them as named exports.
 *
 * Forms intentionally do NOT validate at the field level; the orchestrator
 * runs the kind's zod schema (Phase 6) on save. Field-level errors land in
 * Phase 9 polish.
 */
import { useState } from "react"
import { useTranslations } from "next-intl"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
import { Button } from "@/components/ui/button"
import { Plus, Trash2 } from "lucide-react"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  Field,
  FieldGroup,
  readBoolean,
  readNumber,
  readString,
  patchParam,
  FieldRow,
} from "./shared"
import { ExpressionField } from "./shared/expression-field"
import { SubworkflowPicker } from "./shared/entity-picker"
import { DurationField } from "./shared/duration-field"
import { OutputSchemaField } from "./output-schema-field"
import { SchemaForm, type JsonSchema } from "./schema-form"
import { useLiveQuery } from "dexie-react-hooks"
import { getWorkflow } from "@/lib/db/workflows"
import {
  BranchConfigV1,
  BranchConfigV2,
  LoopConfigV1,
  LoopConfigV2,
  NOTE_COLOR_OPTIONS,
  PiiGateField,
  SwitchConfigV1,
  SwitchConfigV2,
  parseObjectJson,
} from "./form-support"
import type { ConfigProps } from "./form-support"

// ── flow.branch ───────────────────────────────────────────────────────────
export function BranchConfig({ params, onChange, typeVersion }: ConfigProps) {
  const t = useTranslations("workflows.forms.branch")
  if ((typeVersion ?? 1) >= 2) {
    return <BranchConfigV2 params={params} onChange={onChange} />
  }
  return <BranchConfigV1 params={params} onChange={onChange} t={t} />
}

// ── flow.set ──────────────────────────────────────────────────────────────
export function SetVariableConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.setVariable")
  const variable = readString(params, "variable")
  const value = readString(params, "value")
  return (
    <FieldGroup>
      <Field label={t("variable.label")} htmlFor="sv-name" name="variable" required>
        <Input
          id="sv-name"
          value={variable}
          onChange={(e) => onChange(patchParam(params, "variable", e.target.value))}
          placeholder={t("variable.placeholder")}
        />
      </Field>
      <Field
        label={t("value.label")}
        htmlFor="sv-value"
        hint={t("value.hint")}
        name="value"
        required
      >
        <ExpressionField
          id="sv-value"
          value={value}
          onChange={(v) => onChange(patchParam(params, "value", v))}
          multiline
          rows={2}
        />
      </Field>
    </FieldGroup>
  )
}

// ── flow.wait ─────────────────────────────────────────────────────────────
export function WaitConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.wait")
  const mode = readString(params, "mode", "duration")
  const durationMs = readNumber(params, "durationMs", 1000)
  return (
    <FieldGroup>
      <Field label={t("mode.label")} htmlFor="w-mode" name="mode">
        <Select value={mode} onValueChange={(v) => onChange(patchParam(params, "mode", v))}>
          <SelectTrigger id="w-mode">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="duration">{t("mode.options.duration")}</SelectItem>
            <SelectItem value="event">{t("mode.options.event")}</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      {mode === "duration" ? (
        <Field
          label={t("durationMs.label")}
          htmlFor="w-dur"
          hint={t("durationMs.hint")}
          name="durationMs"
        >
          <DurationField
            id="w-dur"
            value={durationMs}
            onChange={(next) => onChange(patchParam(params, "durationMs", next))}
          />
        </Field>
      ) : (
        <>
          <Field
            label={t("eventKey.label")}
            htmlFor="w-event-key"
            hint={t("eventKey.hint")}
            name="eventKey"
          >
            <Input
              id="w-event-key"
              value={readString(params, "eventKey")}
              onChange={(e) => onChange(patchParam(params, "eventKey", e.target.value))}
              placeholder={t("eventKey.placeholder")}
            />
          </Field>
          <Field
            label={t("timeoutMs.label")}
            htmlFor="w-event-timeout"
            hint={t("timeoutMs.hint")}
            name="timeoutMs"
          >
            <DurationField
              id="w-event-timeout"
              value={readNumber(params, "timeoutMs", 0)}
              onChange={(next) => onChange(patchParam(params, "timeoutMs", next))}
            />
          </Field>
          <Field
            label={t("correlationId.label")}
            htmlFor="w-correlation"
            hint={t("correlationId.hint")}
            name="correlationId"
          >
            <ExpressionField
              id="w-correlation"
              value={readString(params, "correlationId")}
              onChange={(v) => onChange(patchParam(params, "correlationId", v))}
            />
          </Field>
        </>
      )}
    </FieldGroup>
  )
}

// ── io.http ───────────────────────────────────────────────────────────────
export function HttpRequestConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.httpRequest")
  const method = readString(params, "method", "GET")
  const url = readString(params, "url")
  const body = readString(params, "body")
  const followRedirects = readBoolean(params, "followRedirects", true)
  const piiGate = readString(params, "piiGate", "block")
  return (
    <FieldGroup>
      <Field label={t("method.label")} htmlFor="http-method" name="method">
        <Select value={method} onValueChange={(v) => onChange(patchParam(params, "method", v))}>
          <SelectTrigger id="http-method">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {/* i18n-exempt: HTTP method name (protocol keyword), not UI prose */}
            <SelectItem value="GET">GET</SelectItem>
            {/* i18n-exempt: HTTP method name (protocol keyword), not UI prose */}
            <SelectItem value="POST">POST</SelectItem>
            {/* i18n-exempt: HTTP method name (protocol keyword), not UI prose */}
            <SelectItem value="PUT">PUT</SelectItem>
            {/* i18n-exempt: HTTP method name (protocol keyword), not UI prose */}
            <SelectItem value="PATCH">PATCH</SelectItem>
            {/* i18n-exempt: HTTP method name (protocol keyword), not UI prose */}
            <SelectItem value="DELETE">DELETE</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      <Field label={t("url.label")} htmlFor="http-url" hint={t("url.hint")} name="url" required>
        <Input
          id="http-url"
          value={url}
          onChange={(e) => onChange(patchParam(params, "url", e.target.value))}
          placeholder={t("url.placeholder")}
        />
      </Field>
      {method !== "GET" ? (
        <Field label={t("body.label")} htmlFor="http-body" hint={t("body.hint")} name="body">
          <ExpressionField
            id="http-body"
            value={body}
            onChange={(v) => onChange(patchParam(params, "body", v))}
            multiline
            rows={4}
          />
        </Field>
      ) : null}
      <PiiGateField id="http-pii" value={piiGate} params={params} onChange={onChange} t={t} />
      <div className="flex items-center justify-between gap-3">
        <Field
          label={t("followRedirects.label")}
          htmlFor="http-follow"
          hint={t("followRedirects.hint")}
          name="followRedirects"
        >
          <Switch
            id="http-follow"
            checked={followRedirects}
            onCheckedChange={(v) => onChange(patchParam(params, "followRedirects", v))}
          />
        </Field>
      </div>
    </FieldGroup>
  )
}

// ── data.code ─────────────────────────────────────────────────────────────
export function CodeConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.code")
  const code = readString(
    params,
    "code",
    "// upstream is the merged outputs of all parents.\nreturn { result: upstream }"
  )
  return (
    <FieldGroup>
      <Field label={t("code.label")} htmlFor="code-body" hint={t("code.hint")} name="code" required>
        <Textarea
          id="code-body"
          value={code}
          onChange={(e) => onChange(patchParam(params, "code", e.target.value))}
          rows={10}
          className="font-mono text-xs"
        />
      </Field>
    </FieldGroup>
  )
}

// ── data.template ─────────────────────────────────────────────────────────
export function TemplateConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.template")
  const template = readString(params, "template")
  return (
    <FieldGroup>
      <Field
        label={t("template.label")}
        htmlFor="tmpl"
        hint={t("template.hint")}
        name="template"
        required
      >
        <ExpressionField
          id="tmpl"
          value={template}
          onChange={(v) => onChange(patchParam(params, "template", v))}
          multiline
          rows={6}
        />
      </Field>
    </FieldGroup>
  )
}

// ── data.transform ────────────────────────────────────────────────────────
export function TransformConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.transform")
  const op = readString(params, "operation", "map")
  const expression = readString(params, "expression")
  return (
    <FieldGroup>
      <Field label={t("operation.label")} htmlFor="tr-op" name="operation">
        <Select value={op} onValueChange={(v) => onChange(patchParam(params, "operation", v))}>
          <SelectTrigger id="tr-op">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="map">{t("operation.options.map")}</SelectItem>
            <SelectItem value="filter">{t("operation.options.filter")}</SelectItem>
            <SelectItem value="reduce">{t("operation.options.reduce")}</SelectItem>
            <SelectItem value="sort">{t("operation.options.sort")}</SelectItem>
            <SelectItem value="flatten">{t("operation.options.flatten")}</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      {op === "reduce" ? (
        <p className="text-xs text-muted-foreground">{t("operation.reduceHint")}</p>
      ) : null}
      <Field
        label={t("expression.label")}
        htmlFor="tr-expr"
        hint={t("expression.hint")}
        name="expression"
        required
      >
        <ExpressionField
          id="tr-expr"
          value={expression}
          onChange={(v) => onChange(patchParam(params, "expression", v))}
          multiline
          rows={3}
        />
      </Field>
    </FieldGroup>
  )
}

// ── data.aggregate ────────────────────────────────────────────────────────
export function AggregateConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.aggregate")
  const op = readString(params, "operation", "collect")
  const keyExpression = readString(params, "keyExpression")
  const numericField = readString(params, "numericField")
  const numericOp = readString(params, "numericOp", "sum")
  const reducerExpression = readString(params, "reducerExpression")
  const needsKey = op === "group-by" || op === "dedupe"
  // `initialValue` is `unknown`, so it is edited as JSON. Keep the raw text
  // locally — a half-typed literal must stay visible without being pushed
  // into params, and `undefined` (no seed) has to stay distinct from `null`.
  const [initialValueText, setInitialValueText] = useState(() =>
    params.initialValue === undefined ? "" : JSON.stringify(params.initialValue)
  )
  return (
    <FieldGroup>
      <Field
        label={t("operation.label")}
        htmlFor="agg-op"
        hint={t("operation.hint")}
        name="operation"
      >
        <Select value={op} onValueChange={(v) => onChange(patchParam(params, "operation", v))}>
          <SelectTrigger id="agg-op">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="collect">{t("operation.options.collect")}</SelectItem>
            <SelectItem value="concat">{t("operation.options.concat")}</SelectItem>
            <SelectItem value="merge-objects">{t("operation.options.mergeObjects")}</SelectItem>
            <SelectItem value="group-by">{t("operation.options.groupBy")}</SelectItem>
            <SelectItem value="dedupe">{t("operation.options.dedupe")}</SelectItem>
            <SelectItem value="numeric">{t("operation.options.numeric")}</SelectItem>
            <SelectItem value="custom">{t("operation.options.custom")}</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      {needsKey ? (
        <Field
          label={t("keyExpression.label")}
          htmlFor="agg-key"
          hint={t("keyExpression.hint")}
          name="keyExpression"
        >
          <ExpressionField
            id="agg-key"
            value={keyExpression}
            onChange={(v) => onChange(patchParam(params, "keyExpression", v))}
            multiline
            rows={2}
          />
        </Field>
      ) : null}
      {op === "numeric" ? (
        <FieldRow>
          <Field label={t("numericOp.label")} htmlFor="agg-nop" name="numericOp">
            <Select
              value={numericOp}
              onValueChange={(v) => onChange(patchParam(params, "numericOp", v))}
            >
              <SelectTrigger id="agg-nop">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="sum">{t("numericOp.options.sum")}</SelectItem>
                <SelectItem value="avg">{t("numericOp.options.avg")}</SelectItem>
                <SelectItem value="min">{t("numericOp.options.min")}</SelectItem>
                <SelectItem value="max">{t("numericOp.options.max")}</SelectItem>
                <SelectItem value="count">{t("numericOp.options.count")}</SelectItem>
              </SelectContent>
            </Select>
          </Field>
          <Field
            label={t("numericField.label")}
            htmlFor="agg-nfield"
            hint={t("numericField.hint")}
            name="numericField"
          >
            <ExpressionField
              id="agg-nfield"
              value={numericField}
              onChange={(v) => onChange(patchParam(params, "numericField", v))}
              multiline
              rows={2}
            />
          </Field>
        </FieldRow>
      ) : null}
      {op === "custom" ? (
        <Field
          label={t("reducerExpression.label")}
          htmlFor="agg-reducer"
          hint={t("reducerExpression.hint")}
          name="reducerExpression"
        >
          <Textarea
            id="agg-reducer"
            value={reducerExpression}
            onChange={(e) => onChange(patchParam(params, "reducerExpression", e.target.value))}
            rows={3}
            className="font-mono text-xs"
            placeholder={t("reducerExpression.placeholder")}
          />
        </Field>
      ) : null}
      {op === "custom" ? (
        <Field
          label={t("initialValue.label")}
          htmlFor="agg-initial"
          hint={t("initialValue.hint")}
          name="initialValue"
        >
          <Textarea
            id="agg-initial"
            value={initialValueText}
            onChange={(e) => {
              const raw = e.target.value
              setInitialValueText(raw)
              if (raw.trim() === "") {
                onChange(patchParam(params, "initialValue", undefined))
                return
              }
              try {
                onChange(patchParam(params, "initialValue", JSON.parse(raw)))
              } catch {
                // Keep the draft in the box; don't push half-typed JSON into
                // params, where it would seed the reducer with a string.
              }
            }}
            rows={2}
            className="font-mono text-xs"
            placeholder={t("initialValue.placeholder")}
          />
        </Field>
      ) : null}
    </FieldGroup>
  )
}

export function NoteConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.note")
  const text = readString(params, "text")
  const color = readString(params, "color", "yellow")
  return (
    <FieldGroup>
      <Field label={t("text.label")} htmlFor="note-text" name="text">
        <Textarea
          id="note-text"
          value={text}
          onChange={(e) => onChange(patchParam(params, "text", e.target.value))}
          rows={6}
        />
      </Field>
      <Field label={t("color.label")} htmlFor="note-color" name="color">
        <div
          id="note-color"
          role="radiogroup"
          aria-label={t("color.ariaGroup")}
          className="flex gap-1.5"
        >
          {NOTE_COLOR_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              role="radio"
              aria-checked={color === opt.value}
              aria-label={t(`color.options.${opt.value}`)}
              data-testid={`note-color-${opt.value}`}
              onClick={() => onChange(patchParam(params, "color", opt.value))}
              className={`size-6 rounded-full border-2 transition ${opt.swatch} ${
                color === opt.value
                  ? "border-foreground scale-110"
                  : "border-transparent hover:scale-105"
              }`}
            />
          ))}
        </div>
      </Field>
    </FieldGroup>
  )
}

// ── generic JSON fallback ─────────────────────────────────────────────────
export function GenericJsonConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.genericJson")
  const [text, setText] = useState(() => JSON.stringify(params, null, 2))
  const [error, setError] = useState<string | null>(null)
  // Reset text when params change externally (e.g., undo) — render-time setState.
  const [prevParams, setPrevParams] = useState(params)
  if (prevParams !== params) {
    setPrevParams(params)
    setText(JSON.stringify(params, null, 2))
    setError(null)
  }
  return (
    <FieldGroup>
      <Field label={t("params.label")} htmlFor="gen-json" hint={t("params.hint")}>
        <Textarea
          id="gen-json"
          value={text}
          onChange={(e) => {
            const next = e.target.value
            setText(next)
            try {
              const parsed = JSON.parse(next)
              if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                onChange(parsed as Record<string, unknown>)
                setError(null)
              } else {
                setError(t("errorTopLevelObject"))
              }
            } catch (err) {
              setError(err instanceof Error ? err.message : t("errorInvalidJson"))
            }
          }}
          rows={10}
          className="font-mono text-xs"
        />
      </Field>
      {error ? (
        <p className="text-xs text-destructive" role="alert">
          {error}
        </p>
      ) : null}
    </FieldGroup>
  )
}

// ── flow.switch ───────────────────────────────────────────────────────────
export function SwitchConfig({ params, onChange, typeVersion }: ConfigProps) {
  if ((typeVersion ?? 1) >= 2) {
    return <SwitchConfigV2 params={params} onChange={onChange} />
  }
  return <SwitchConfigV1 params={params} onChange={onChange} />
}

// ── flow.split ────────────────────────────────────────────────────────────
export function SplitConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.split")
  const labels = Array.isArray(params.branchLabels) ? (params.branchLabels as string[]) : ["A", "B"]

  function updateLabels(next: string[]) {
    onChange(patchParam(params, "branchLabels", next))
  }

  return (
    <FieldGroup>
      <Field
        label={t("branchLabels.label")}
        htmlFor="sp-labels"
        hint={t("branchLabels.hint")}
        name="branchLabels"
        required
      >
        <div className="space-y-2">
          {labels.map((label, i) => (
            <div key={i} className="flex gap-2">
              <Input
                value={label}
                onChange={(e) => {
                  const next = [...labels]
                  next[i] = e.target.value
                  updateLabels(next)
                }}
                placeholder={t("branchLabels.branchPlaceholder", { n: i + 1 })}
              />
              <Button
                type="button"
                size="icon"
                variant="ghost"
                onClick={() => updateLabels(labels.filter((_, j) => j !== i))}
                aria-label={t("branchLabels.removeBranch")}
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          ))}
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() =>
              updateLabels([
                ...labels,
                t("branchLabels.branchPlaceholder", { n: labels.length + 1 }),
              ])
            }
          >
            <Plus className="size-3.5 mr-1" /> {t("branchLabels.addBranch")}
          </Button>
        </div>
      </Field>
    </FieldGroup>
  )
}

// ── flow.join ─────────────────────────────────────────────────────────────
export function JoinConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.join")
  const joinPolicy = readString(params, "joinPolicy", "all")
  const timeoutMs = readNumber(params, "timeoutMs", 0)
  const aggregate =
    params.aggregate && typeof params.aggregate === "object"
      ? (params.aggregate as Record<string, unknown>)
      : undefined
  const aggregateOn = !!aggregate?.operation
  return (
    <FieldGroup>
      <Field label={t("joinPolicy.label")} htmlFor="jn-policy" name="joinPolicy">
        <Select
          value={joinPolicy}
          onValueChange={(v) => onChange(patchParam(params, "joinPolicy", v))}
        >
          <SelectTrigger id="jn-policy">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{t("joinPolicy.options.all")}</SelectItem>
            <SelectItem value="any">{t("joinPolicy.options.any")}</SelectItem>
            <SelectItem value="race">{t("joinPolicy.options.race")}</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      <Field
        label={t("timeoutMs.label")}
        htmlFor="jn-timeout"
        hint={t("timeoutMs.hint")}
        name="timeoutMs"
      >
        <Input
          id="jn-timeout"
          type="number"
          min={0}
          value={timeoutMs}
          onChange={(e) => onChange(patchParam(params, "timeoutMs", Number(e.target.value) || 0))}
        />
      </Field>
      {/* Optional gather→reduce (D6③): reuse the aggregate form on a nested param. */}
      <Field
        label={t("aggregate.label")}
        htmlFor="jn-agg-on"
        hint={t("aggregate.hint")}
        name="aggregate"
      >
        <Switch
          id="jn-agg-on"
          checked={aggregateOn}
          onCheckedChange={(on) =>
            onChange(patchParam(params, "aggregate", on ? { operation: "collect" } : undefined))
          }
        />
      </Field>
      {aggregateOn ? (
        <div className="rounded-md border p-3">
          <AggregateConfig
            params={aggregate ?? {}}
            onChange={(next) => onChange(patchParam(params, "aggregate", next))}
          />
        </div>
      ) : null}
    </FieldGroup>
  )
}

// ── flow.loop ─────────────────────────────────────────────────────────────
export function LoopConfig({ params, onChange, typeVersion }: ConfigProps) {
  if ((typeVersion ?? 1) >= 2) {
    return <LoopConfigV2 params={params} onChange={onChange} />
  }
  return <LoopConfigV1 params={params} onChange={onChange} />
}

// ── flow.break / flow.continue ────────────────────────────────────────────
export function BreakConfig() {
  const t = useTranslations("workflows.forms.loopJump")
  return <p className="text-xs text-muted-foreground">{t("breakIntro")}</p>
}

export function ContinueConfig() {
  const t = useTranslations("workflows.forms.loopJump")
  return <p className="text-xs text-muted-foreground">{t("continueIntro")}</p>
}

// ── flow.subworkflow ──────────────────────────────────────────────────────
export function SubworkflowConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.subworkflow")
  const workflowId = readString(params, "workflowId")
  const inputJson = readString(params, "inputJson", "{}")
  // Typed input fields (D3b/D5): when the selected target is PUBLISHED with a
  // declared object inputSchema, render schema-driven fields instead of the
  // raw JSON textarea. Unpublished / schema-less targets keep the fallback —
  // the user is never stranded. Live query so publishing the target while
  // this inspector is open upgrades the form in place.
  const target = useLiveQuery(
    () => (workflowId && !workflowId.includes("{{") ? getWorkflow(workflowId) : undefined),
    [workflowId]
  )
  const inputSchema = target?.published ? target.interface?.inputSchema : undefined
  const typedSchema =
    inputSchema &&
    (inputSchema as JsonSchema).type === "object" &&
    (inputSchema as JsonSchema).properties &&
    Object.keys((inputSchema as JsonSchema).properties ?? {}).length > 0
      ? (inputSchema as JsonSchema)
      : undefined
  const inputObject =
    params.input && typeof params.input === "object" && !Array.isArray(params.input)
      ? (params.input as Record<string, unknown>)
      : (parseObjectJson(inputJson) ?? {})
  return (
    <FieldGroup>
      <Field label={t("workflowId.label")} htmlFor="sw-wf" name="workflowId" required>
        <SubworkflowPicker
          id="sw-wf"
          value={workflowId}
          onChange={(v) => onChange(patchParam(params, "workflowId", v))}
        />
      </Field>
      {typedSchema ? (
        <Field label={t("typedInput.label")} hint={t("typedInput.hint")} name="input">
          <SchemaForm
            schema={typedSchema}
            params={inputObject}
            onChange={(next) =>
              // Keep `input` (what the executor validates + sends) and
              // `inputJson` (the fallback textarea's source) in lockstep so
              // switching targets never shows stale text.
              onChange({
                ...params,
                input: next,
                inputJson: JSON.stringify(next, null, 2),
              })
            }
          />
        </Field>
      ) : (
        <Field
          label={t("inputJson.label")}
          htmlFor="sw-input"
          hint={t("inputJson.hint")}
          name="inputJson"
        >
          <Textarea
            id="sw-input"
            value={inputJson}
            onChange={(e) => {
              const next = patchParam(params, "inputJson", e.target.value) as Record<
                string,
                unknown
              >
              try {
                const parsed = JSON.parse(e.target.value)
                ;(next as Record<string, unknown>).input = parsed
              } catch {
                // ignore
              }
              onChange(next)
            }}
            rows={5}
            className="font-mono text-xs"
          />
        </Field>
      )}
    </FieldGroup>
  )
}

// ── io.webhook.respond ────────────────────────────────────────────────────
export function WebhookRespondConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.webhookRespond")
  const status = readNumber(params, "status", 200)
  const headersJson = readString(params, "headersJson", "{}")
  const body = readString(params, "body")
  return (
    <FieldGroup>
      <p className="text-[11px] text-wf-status-running">{t("desktopOnly")}</p>
      <FieldRow>
        <Field label={t("status.label")} htmlFor="wr-status" name="status">
          <Input
            id="wr-status"
            type="number"
            min={100}
            max={599}
            value={status}
            onChange={(e) => onChange(patchParam(params, "status", Number(e.target.value) || 200))}
          />
        </Field>
        <Field
          label={t("headersJson.label")}
          htmlFor="wr-headers"
          hint={t("headersJson.hint")}
          name="headersJson"
        >
          <Input
            id="wr-headers"
            value={headersJson}
            onChange={(e) => {
              const next = patchParam(params, "headersJson", e.target.value) as Record<
                string,
                unknown
              >
              try {
                const parsed = JSON.parse(e.target.value)
                if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                  ;(next as Record<string, unknown>).headers = parsed
                }
              } catch {
                // ignore
              }
              onChange(next)
            }}
            placeholder={t("headersJson.placeholder")}
            className="font-mono text-xs"
          />
        </Field>
      </FieldRow>
      <Field label={t("body.label")} htmlFor="wr-body" hint={t("body.hint")} name="body">
        <Textarea
          id="wr-body"
          value={body}
          onChange={(e) => onChange(patchParam(params, "body", e.target.value))}
          rows={5}
          className="font-mono text-xs"
        />
      </Field>
    </FieldGroup>
  )
}

// ── io.output ─────────────────────────────────────────────────────────────
export function OutputConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.output")
  const value = readString(params, "value")
  const mode = params.onSchemaViolation === "soft" ? "soft" : "fail"
  return (
    <FieldGroup>
      <Field label={t("value.label")} htmlFor="out-value" hint={t("value.hint")} name="value">
        <ExpressionField
          id="out-value"
          value={value}
          onChange={(v) => onChange(patchParam(params, "value", v))}
          multiline
          rows={3}
        />
      </Field>
      <Field label={t("outputSchema.label")} hint={t("outputSchema.hint")} name="outputSchema">
        <OutputSchemaField
          value={
            params.outputSchema && typeof params.outputSchema === "object"
              ? (params.outputSchema as Record<string, unknown>)
              : undefined
          }
          onChange={(next) => onChange(patchParam(params, "outputSchema", next))}
          idPrefix="out"
        />
      </Field>
      <Field
        label={t("onSchemaViolation.label")}
        htmlFor="out-osv"
        hint={t("onSchemaViolation.hint")}
        name="onSchemaViolation"
      >
        <Select
          value={mode}
          onValueChange={(v) => onChange(patchParam(params, "onSchemaViolation", v))}
        >
          <SelectTrigger id="out-osv">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="fail">{t("onSchemaViolation.fail")}</SelectItem>
            <SelectItem value="soft">{t("onSchemaViolation.soft")}</SelectItem>
          </SelectContent>
        </Select>
      </Field>
    </FieldGroup>
  )
}

// ── annotation.group ──────────────────────────────────────────────────────
export function GroupAnnotationConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.groupAnnotation")
  const title = readString(params, "title")
  const color = readString(params, "color", "zinc")
  const width = readNumber(params, "width", 480)
  const height = readNumber(params, "height", 320)
  return (
    <FieldGroup>
      <Field label={t("title.label")} htmlFor="grp-title" name="title">
        <Input
          id="grp-title"
          value={title}
          onChange={(e) => onChange(patchParam(params, "title", e.target.value))}
          placeholder={t("title.placeholder")}
        />
      </Field>
      <Field label={t("color.label")} htmlFor="grp-color" name="color">
        <Select value={color} onValueChange={(v) => onChange(patchParam(params, "color", v))}>
          <SelectTrigger id="grp-color">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="zinc">{t("color.options.zinc")}</SelectItem>
            <SelectItem value="emerald">{t("color.options.emerald")}</SelectItem>
            <SelectItem value="sky">{t("color.options.sky")}</SelectItem>
            <SelectItem value="violet">{t("color.options.violet")}</SelectItem>
            <SelectItem value="amber">{t("color.options.amber")}</SelectItem>
            <SelectItem value="rose">{t("color.options.rose")}</SelectItem>
            <SelectItem value="cyan">{t("color.options.cyan")}</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      <FieldRow>
        <Field label={t("width.label")} htmlFor="grp-w" name="width">
          <Input
            id="grp-w"
            type="number"
            min={200}
            value={width}
            onChange={(e) => onChange(patchParam(params, "width", Number(e.target.value) || 480))}
          />
        </Field>
        <Field label={t("height.label")} htmlFor="grp-h" name="height">
          <Input
            id="grp-h"
            type="number"
            min={100}
            value={height}
            onChange={(e) => onChange(patchParam(params, "height", Number(e.target.value) || 320))}
          />
        </Field>
      </FieldRow>
    </FieldGroup>
  )
}

// ── flow.catch ─────────────────────────────────────────────────────────────
// Terminal-failure recovery entrypoint. Receives the error envelope on
// `{{ $node['id'].error }}`; downstream is the recovery / notify path.
export function CatchConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.catch")
  const scope = readString(params, "scope", "workflow")
  return (
    <FieldGroup>
      <p className="text-xs text-muted-foreground">{t("intro")}</p>
      <Field label={t("scope.label")} htmlFor="catch-scope" name="scope" hint={t("scope.hint")}>
        <Select value={scope} onValueChange={(v) => onChange(patchParam(params, "scope", v))}>
          <SelectTrigger id="catch-scope">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="workflow">{t("scope.options.workflow")}</SelectItem>
            <SelectItem value="upstream">{t("scope.options.upstream")}</SelectItem>
          </SelectContent>
        </Select>
      </Field>
    </FieldGroup>
  )
}
