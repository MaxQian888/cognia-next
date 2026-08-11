"use client"

/**
 * Inspector forms for the eval nodes (`eval.run`, `eval.gate`). Param shapes
 * match `lib/workflow/nodes/params-schemas.ts` and the executors in
 * `lib/workflow/nodes/evaluation/index.ts`. Pattern mirrors `git-ocr-forms.tsx`: shared
 * `Field`/`FieldGroup`/`patchParam` helpers, `ExpressionField` for
 * expression-capable strings.
 */

import { useTranslations } from "next-intl"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Field, FieldGroup, patchParam, readNumber, readString } from "./shared"
import { ExpressionField } from "./shared/expression-field"

type Params = Record<string, unknown>
interface ConfigProps {
  params: Params
  onChange: (next: Params) => void
}

function readList(params: Params, key: string): string {
  const v = params[key]
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").join(", ") : ""
}
function parseList(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
}

// ── eval.run ─────────────────────────────────────────────────────────────────

export function EvalRunConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.eval.run")
  const kind = readString(params, "targetKind", "chat") || "chat"
  return (
    <FieldGroup>
      <Field
        label={t("datasetId.label")}
        htmlFor="eval-ds"
        hint={t("datasetId.hint")}
        name="datasetId"
        required
      >
        <ExpressionField
          id="eval-ds"
          value={readString(params, "datasetId")}
          onChange={(v) => onChange(patchParam(params, "datasetId", v))}
          placeholder={t("datasetId.placeholder")}
        />
      </Field>
      <Field label={t("targetKind.label")} htmlFor="eval-kind" name="targetKind">
        <Select value={kind} onValueChange={(v) => onChange(patchParam(params, "targetKind", v))}>
          <SelectTrigger id="eval-kind" aria-label={t("targetKind.label")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="chat">{t("targetKind.chat")}</SelectItem>
            <SelectItem value="team">{t("targetKind.team")}</SelectItem>
            <SelectItem value="workflow">{t("targetKind.workflow")}</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      {kind === "chat" && (
        <Field label={t("model.label")} name="model" required hint={t("model.hint")}>
          <ExpressionField
            value={readString(params, "model")}
            onChange={(v) => onChange(patchParam(params, "model", v))}
            placeholder={t("model.placeholder")}
          />
        </Field>
      )}
      {kind === "chat" && (
        <Field label={t("characterId.label")} htmlFor="eval-char" name="characterId">
          <Input
            id="eval-char"
            value={readString(params, "characterId")}
            onChange={(e) => onChange(patchParam(params, "characterId", e.target.value))}
            placeholder={t("characterId.placeholder")}
          />
        </Field>
      )}
      {kind === "team" && (
        <Field label={t("teamId.label")} name="teamId" required>
          <ExpressionField
            value={readString(params, "teamId")}
            onChange={(v) => onChange(patchParam(params, "teamId", v))}
            placeholder={t("teamId.placeholder")}
          />
        </Field>
      )}
      {kind === "workflow" && (
        <Field label={t("workflowId.label")} name="workflowId" required>
          <ExpressionField
            value={readString(params, "workflowId")}
            onChange={(v) => onChange(patchParam(params, "workflowId", v))}
            placeholder={t("workflowId.placeholder")}
          />
        </Field>
      )}
      <Field label={t("label.label")} htmlFor="eval-label" hint={t("label.hint")} name="label">
        <Input
          id="eval-label"
          value={readString(params, "label")}
          onChange={(e) => onChange(patchParam(params, "label", e.target.value))}
        />
      </Field>
      <Field label={t("k.label")} htmlFor="eval-k" hint={t("k.hint")} name="k">
        <Input
          id="eval-k"
          type="number"
          min={1}
          value={readNumber(params, "k", 1)}
          onChange={(e) =>
            onChange(patchParam(params, "k", Math.max(1, Number(e.target.value) || 1)))
          }
        />
      </Field>
      <Field
        label={t("scorerIds.label")}
        htmlFor="eval-scorers"
        hint={t("scorerIds.hint")}
        name="scorerIds"
      >
        <Input
          id="eval-scorers"
          value={readList(params, "scorerIds")}
          onChange={(e) => onChange(patchParam(params, "scorerIds", parseList(e.target.value)))}
          placeholder={t("scorerIds.placeholder")}
        />
      </Field>
      <Field label={t("split.label")} htmlFor="eval-split" name="split">
        <Input
          id="eval-split"
          value={readString(params, "split")}
          onChange={(e) => onChange(patchParam(params, "split", e.target.value))}
        />
      </Field>
      <Field label={t("capabilities.label")} htmlFor="eval-caps" name="capabilities">
        <Input
          id="eval-caps"
          value={readList(params, "capabilities")}
          onChange={(e) => onChange(patchParam(params, "capabilities", parseList(e.target.value)))}
        />
      </Field>
    </FieldGroup>
  )
}

// ── eval.gate ────────────────────────────────────────────────────────────────

const GATE_KEYS = ["minPassAt1", "minPassHatK", "minScorerPassRate", "maxTotalCostUsd"] as const

export function EvalGateConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.eval.gate")
  return (
    <FieldGroup>
      <Field
        label={t("runId.label")}
        htmlFor="eval-runid"
        hint={t("runId.hint")}
        name="runId"
        required
      >
        <ExpressionField
          id="eval-runid"
          value={readString(params, "runId")}
          onChange={(v) => onChange(patchParam(params, "runId", v))}
          placeholder={t("runId.placeholder")}
        />
      </Field>
      {GATE_KEYS.map((key) => (
        <Field key={key} label={t(`${key}.label`)} htmlFor={`eval-${key}`} name={key}>
          <Input
            id={`eval-${key}`}
            type="number"
            step="0.01"
            value={typeof params[key] === "number" ? String(params[key]) : ""}
            onChange={(e) => {
              const raw = e.target.value
              onChange(patchParam(params, key, raw === "" ? undefined : Number(raw)))
            }}
          />
        </Field>
      ))}
    </FieldGroup>
  )
}
