"use client"

import { useTranslations } from "next-intl"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import { Switch } from "@/components/ui/switch"
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
import { CharacterPicker, SubworkflowPicker } from "./shared/entity-picker"
import { TypedOutputFields, OutputSchemaField } from "./output-schema-field"
import { getTransformersCapabilities } from "@cognia/transformers-runtime/capabilities"
import { TRANSFORMERS_MODEL_PRESETS } from "@cognia/transformers-runtime/models"
import type { TransformersTask } from "@cognia/transformers-runtime/types"
import {
  AiExplicitProviderFields,
  CredentialRefField,
  BROWSER_MODEL_TASKS,
  DEFAULT_COUNCILLORS,
  ENSEMBLE_AGG_DEFAULTS,
  PiiGateField,
  clampNumberInput,
  parseArrayJson,
  readArrayJsonParam,
} from "./form-support"
import type { ConfigProps } from "./form-support"

// ── ai.prompt ─────────────────────────────────────────────────────────────
export function AiPromptConfig({ params, onChange, typeVersion }: ConfigProps) {
  const t = useTranslations("workflows.forms.aiPrompt")
  const v2 = (typeVersion ?? 1) >= 2
  const mode = (readString(params, "mode") || "explicit") as "explicit" | "routed"
  const routed = v2 && mode === "routed"
  const modelAlias = readString(params, "modelAlias")
  const piiGate = readString(params, "piiGate") || "block"
  const systemPrompt = readString(params, "systemPrompt")
  const userPrompt = readString(params, "userPrompt")
  const temperature = readNumber(params, "temperature", 0.7)
  const responseFormat = readString(params, "responseFormat") || "text"
  const jsonSchema = readString(params, "jsonSchema")
  const characterId = readString(params, "characterId")
  return (
    <FieldGroup>
      {v2 ? (
        <Field label={t("mode.label")} htmlFor="ai-mode" hint={t("mode.hint")} name="mode">
          <Select value={mode} onValueChange={(v) => onChange(patchParam(params, "mode", v))}>
            <SelectTrigger id="ai-mode">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="explicit">{t("mode.explicit")}</SelectItem>
              <SelectItem value="routed">{t("mode.routed")}</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      ) : null}
      {routed ? (
        <Field
          label={t("modelAlias.label")}
          htmlFor="ai-alias"
          hint={t("modelAlias.hint")}
          name="modelAlias"
        >
          <Input
            id="ai-alias"
            value={modelAlias}
            onChange={(e) => onChange(patchParam(params, "modelAlias", e.target.value))}
            placeholder={t("modelAlias.placeholder")}
          />
        </Field>
      ) : (
        <AiExplicitProviderFields params={params} onChange={onChange} t={t} idPrefix="ai" />
      )}
      {v2 ? (
        <PiiGateField
          id="ai-pii"
          value={piiGate}
          params={params}
          onChange={onChange}
          t={t}
          allowOff
        />
      ) : null}
      {v2 ? (
        <Field
          label={t("characterId.label")}
          htmlFor="ai-character"
          hint={t("characterId.hint")}
          name="characterId"
        >
          <CharacterPicker
            id="ai-character"
            value={characterId}
            onChange={(v) => onChange(patchParam(params, "characterId", v))}
          />
        </Field>
      ) : null}
      <Field label={t("systemPrompt.label")} htmlFor="ai-system" name="systemPrompt">
        <ExpressionField
          id="ai-system"
          value={systemPrompt}
          onChange={(v) => onChange(patchParam(params, "systemPrompt", v))}
          multiline
          rows={3}
        />
      </Field>
      <Field label={t("userPrompt.label")} htmlFor="ai-user" name="userPrompt" required>
        <ExpressionField
          id="ai-user"
          value={userPrompt}
          onChange={(v) => onChange(patchParam(params, "userPrompt", v))}
          multiline
          rows={5}
        />
      </Field>
      <Field
        label={t("temperature.label")}
        htmlFor="ai-temp"
        hint={t("temperature.hint")}
        name="temperature"
      >
        <Input
          id="ai-temp"
          type="number"
          step={0.1}
          min={0}
          max={2}
          value={temperature}
          onChange={(e) => onChange(patchParam(params, "temperature", Number(e.target.value) || 0))}
        />
      </Field>
      <Field
        label={t("responseFormat.label")}
        htmlFor="ai-format"
        hint={t("responseFormat.hint")}
        name="responseFormat"
      >
        <Select
          value={responseFormat}
          onValueChange={(v) => onChange(patchParam(params, "responseFormat", v))}
        >
          <SelectTrigger id="ai-format">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="text">{t("responseFormat.text")}</SelectItem>
            <SelectItem value="json">{t("responseFormat.json")}</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      {responseFormat === "json" ? (
        <Field
          label={t("jsonSchema.label")}
          htmlFor="ai-schema"
          hint={t("jsonSchema.hint")}
          name="jsonSchema"
        >
          <Textarea
            id="ai-schema"
            value={jsonSchema}
            onChange={(e) => onChange(patchParam(params, "jsonSchema", e.target.value))}
            rows={4}
            className="font-mono text-xs"
            placeholder={t("jsonSchema.placeholder")}
          />
        </Field>
      ) : null}
      {responseFormat === "json" ? (
        <TypedOutputFields params={params} onChange={onChange} idPrefix="ai" />
      ) : null}
    </FieldGroup>
  )
}

export function AiCouncilConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.aiCouncil")
  const prompt = readString(params, "prompt")
  const synthesizerAlias = readString(params, "synthesizerAlias")
  const synthesisInstructions = readString(params, "synthesisInstructions")
  const executionMode = readString(params, "executionMode", "parallel")
  const timeoutMs = readNumber(params, "timeoutMs", 60000)
  const maxConcurrency = readNumber(params, "maxConcurrency", 4)
  const piiGate = readString(params, "piiGate", "block")
  // Raw-first so hand-typing (which transits invalid intermediate JSON) isn't
  // reverted every keystroke — mirrors the headers field's readStringRecordJsonParam.
  const councillorsJson = readArrayJsonParam(
    params,
    "councillorsJson",
    "councillors",
    DEFAULT_COUNCILLORS
  )

  return (
    <FieldGroup>
      <Field label={t("prompt.label")} htmlFor="council-prompt" name="prompt" required>
        <ExpressionField
          id="council-prompt"
          value={prompt}
          onChange={(v) => onChange(patchParam(params, "prompt", v))}
          multiline
          rows={5}
        />
      </Field>
      <Field
        label={t("councillorsJson.label")}
        htmlFor="council-councillors"
        hint={t("councillorsJson.hint")}
        name="councillors"
        required
      >
        <Textarea
          id="council-councillors"
          value={councillorsJson}
          onChange={(e) => {
            const next = patchParam(params, "councillorsJson", e.target.value) as Record<
              string,
              unknown
            >
            const parsed = parseArrayJson(e.target.value)
            if (parsed) next.councillors = parsed
            onChange(next)
          }}
          rows={6}
          className="font-mono text-xs"
          placeholder={t("councillorsJson.placeholder")}
        />
      </Field>
      <Field
        label={t("synthesizerAlias.label")}
        htmlFor="council-synth"
        hint={t("synthesizerAlias.hint")}
        name="synthesizerAlias"
        required
      >
        <Input
          id="council-synth"
          value={synthesizerAlias}
          onChange={(e) => onChange(patchParam(params, "synthesizerAlias", e.target.value))}
          placeholder={t("synthesizerAlias.placeholder")}
        />
      </Field>
      <Field
        label={t("synthesisInstructions.label")}
        htmlFor="council-instructions"
        hint={t("synthesisInstructions.hint")}
        name="synthesisInstructions"
      >
        <Textarea
          id="council-instructions"
          value={synthesisInstructions}
          onChange={(e) => onChange(patchParam(params, "synthesisInstructions", e.target.value))}
          rows={3}
        />
      </Field>
      <FieldRow>
        <Field label={t("executionMode.label")} htmlFor="council-mode" name="executionMode">
          <Select
            value={executionMode}
            onValueChange={(v) => onChange(patchParam(params, "executionMode", v))}
          >
            <SelectTrigger id="council-mode">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="parallel">{t("executionMode.options.parallel")}</SelectItem>
              <SelectItem value="serial">{t("executionMode.options.serial")}</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field
          label={t("maxConcurrency.label")}
          htmlFor="council-concurrency"
          hint={t("maxConcurrency.hint")}
          name="maxConcurrency"
        >
          <Input
            id="council-concurrency"
            type="number"
            min={1}
            max={16}
            value={maxConcurrency}
            onChange={(e) =>
              onChange(
                patchParam(params, "maxConcurrency", clampNumberInput(e.target.value, 1, 16, 4))
              )
            }
          />
        </Field>
      </FieldRow>
      <Field
        label={t("timeoutMs.label")}
        htmlFor="council-timeout"
        hint={t("timeoutMs.hint")}
        name="timeoutMs"
      >
        <Input
          id="council-timeout"
          type="number"
          min={1000}
          max={600000}
          value={timeoutMs}
          onChange={(e) =>
            onChange(
              patchParam(params, "timeoutMs", clampNumberInput(e.target.value, 1000, 600000, 60000))
            )
          }
        />
      </Field>
      <PiiGateField
        id="council-pii"
        value={piiGate}
        params={params}
        onChange={onChange}
        t={t}
        allowOff
      />
    </FieldGroup>
  )
}

export function EnsembleConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.ensemble")
  const target =
    params.target && typeof params.target === "object"
      ? (params.target as Record<string, unknown>)
      : {}
  const targetKind = (typeof target.kind === "string" ? target.kind : "agent.turn") as
    "agent.turn" | "subworkflow"
  const setTarget = (key: string, value: unknown) =>
    onChange(patchParam(params, "target", { ...target, [key]: value }))
  const agg =
    params.aggregation && typeof params.aggregation === "object"
      ? (params.aggregation as Record<string, unknown>)
      : {}
  const aggKind = typeof agg.kind === "string" ? agg.kind : "majority-vote-on-field"
  const setAgg = (next: Record<string, unknown>) =>
    onChange(patchParam(params, "aggregation", next))
  const prompt = readString(params, "prompt")
  const n = readNumber(params, "n", 3)
  const iterationConcurrency = readNumber(params, "iterationConcurrency", 4)
  const lensText = Array.isArray(params.lens) ? (params.lens as string[]).join("\n") : ""
  const piiGate = readString(params, "piiGate") || "block"
  const synthesizerAlias = readString(params, "synthesizerAlias")

  return (
    <FieldGroup>
      <Field
        label={t("targetKind.label")}
        htmlFor="en-tk"
        hint={t("targetKind.hint")}
        name="targetKind"
      >
        <Select value={targetKind} onValueChange={(v) => setTarget("kind", v)}>
          <SelectTrigger id="en-tk">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="agent.turn">{t("targetKind.options.agentTurn")}</SelectItem>
            <SelectItem value="subworkflow">{t("targetKind.options.subworkflow")}</SelectItem>
          </SelectContent>
        </Select>
      </Field>

      {targetKind === "agent.turn" ? (
        <>
          <Field label={t("prompt.label")} htmlFor="en-prompt" name="prompt" required>
            <ExpressionField
              id="en-prompt"
              value={prompt}
              onChange={(v) => onChange(patchParam(params, "prompt", v))}
              multiline
              rows={4}
            />
          </Field>
          <Field
            label={t("targetModel.label")}
            htmlFor="en-model"
            hint={t("targetModel.hint")}
            name="targetModel"
          >
            <Input
              id="en-model"
              value={typeof target.model === "string" ? target.model : ""}
              onChange={(e) => setTarget("model", e.target.value)}
            />
          </Field>
          <Field label={t("outputSchema.label")} hint={t("outputSchema.hint")} name="outputSchema">
            <OutputSchemaField
              value={
                target.outputSchema && typeof target.outputSchema === "object"
                  ? (target.outputSchema as Record<string, unknown>)
                  : undefined
              }
              onChange={(next) => setTarget("outputSchema", next)}
              idPrefix="en"
            />
          </Field>
        </>
      ) : (
        <Field
          label={t("workflowId.label")}
          htmlFor="en-wf"
          hint={t("workflowId.hint")}
          name="workflowId"
          required
        >
          <SubworkflowPicker
            id="en-wf"
            value={typeof target.workflowId === "string" ? target.workflowId : ""}
            onChange={(v) => setTarget("workflowId", v)}
          />
        </Field>
      )}

      <FieldRow>
        <Field label={t("n.label")} htmlFor="en-n" hint={t("n.hint")} name="n">
          <Input
            id="en-n"
            type="number"
            min={1}
            max={50}
            value={n}
            onChange={(e) => onChange(patchParam(params, "n", Number(e.target.value) || 1))}
          />
        </Field>
        <Field
          label={t("iterationConcurrency.label")}
          htmlFor="en-conc"
          hint={t("iterationConcurrency.hint")}
          name="iterationConcurrency"
        >
          <Input
            id="en-conc"
            type="number"
            min={1}
            max={16}
            value={iterationConcurrency}
            onChange={(e) =>
              onChange(patchParam(params, "iterationConcurrency", Number(e.target.value) || 1))
            }
          />
        </Field>
      </FieldRow>

      <Field label={t("lens.label")} htmlFor="en-lens" hint={t("lens.hint")} name="lens">
        <Textarea
          id="en-lens"
          value={lensText}
          rows={3}
          placeholder={t("lens.placeholder")}
          onChange={(e) => {
            const list = e.target.value
              .split("\n")
              .map((s) => s.trim())
              .filter(Boolean)
            onChange(patchParam(params, "lens", list.length > 0 ? list : undefined))
          }}
        />
      </Field>

      <Field
        label={t("aggregation.label")}
        htmlFor="en-agg"
        hint={t("aggregation.hint")}
        name="aggregation"
      >
        <Select
          value={aggKind}
          onValueChange={(v) => setAgg(ENSEMBLE_AGG_DEFAULTS[v] ?? { kind: v })}
        >
          <SelectTrigger id="en-agg">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="majority-vote-on-field">
              {t("aggregation.options.majority")}
            </SelectItem>
            <SelectItem value="threshold-count">{t("aggregation.options.threshold")}</SelectItem>
            <SelectItem value="best-of-by-score">{t("aggregation.options.bestOf")}</SelectItem>
            <SelectItem value="synthesize-by-final-agent">
              {t("aggregation.options.synthesize")}
            </SelectItem>
          </SelectContent>
        </Select>
      </Field>

      {aggKind === "majority-vote-on-field" || aggKind === "threshold-count" ? (
        <Field
          label={t("aggField.label")}
          htmlFor="en-field"
          hint={t("aggField.hint")}
          name="aggField"
        >
          <Input
            id="en-field"
            value={typeof agg.field === "string" ? agg.field : ""}
            onChange={(e) => setAgg({ ...agg, kind: aggKind, field: e.target.value })}
          />
        </Field>
      ) : null}
      {aggKind === "threshold-count" ? (
        <Field
          label={t("threshold.label")}
          htmlFor="en-thresh"
          hint={t("threshold.hint")}
          name="threshold"
        >
          <Input
            id="en-thresh"
            type="number"
            min={1}
            value={typeof agg.threshold === "number" ? agg.threshold : 2}
            onChange={(e) =>
              setAgg({ ...agg, kind: aggKind, threshold: Number(e.target.value) || 1 })
            }
          />
        </Field>
      ) : null}
      {aggKind === "best-of-by-score" ? (
        <Field
          label={t("scoreField.label")}
          htmlFor="en-score"
          hint={t("scoreField.hint")}
          name="scoreField"
          required
        >
          <Input
            id="en-score"
            value={typeof agg.scoreField === "string" ? agg.scoreField : ""}
            onChange={(e) => setAgg({ ...agg, kind: aggKind, scoreField: e.target.value })}
          />
        </Field>
      ) : null}
      {aggKind === "synthesize-by-final-agent" ? (
        <Field
          label={t("synthesizerAlias.label")}
          htmlFor="en-synth"
          hint={t("synthesizerAlias.hint")}
          name="synthesizerAlias"
          required
        >
          <Input
            id="en-synth"
            value={synthesizerAlias}
            onChange={(e) => onChange(patchParam(params, "synthesizerAlias", e.target.value))}
            placeholder={t("synthesizerAlias.placeholder")}
          />
        </Field>
      ) : null}

      <PiiGateField
        id="en-pii"
        value={piiGate}
        params={params}
        onChange={onChange}
        t={t}
        allowOff
      />
    </FieldGroup>
  )
}

// ── ai.classify ───────────────────────────────────────────────────────────
export function AiClassifyConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.aiClassify")
  const input = readString(params, "input")
  const labelsRaw = readString(params, "labelsRaw")
  const hint = readString(params, "hint")
  return (
    <FieldGroup>
      <AiExplicitProviderFields params={params} onChange={onChange} t={t} idPrefix="ac" />
      <Field
        label={t("labelsRaw.label")}
        htmlFor="ac-labels"
        hint={t("labelsRaw.hint")}
        name="labelsRaw"
        required
      >
        <Input
          id="ac-labels"
          value={labelsRaw}
          onChange={(e) => {
            const next = patchParam(params, "labelsRaw", e.target.value) as Record<string, unknown>
            ;(next as Record<string, unknown>).labels = e.target.value
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
            onChange(next)
          }}
          placeholder={t("labelsRaw.placeholder")}
        />
      </Field>
      <Field
        label={t("input.label")}
        htmlFor="ac-input"
        hint={t("input.hint")}
        name="input"
        required
      >
        <Textarea
          id="ac-input"
          value={input}
          onChange={(e) => onChange(patchParam(params, "input", e.target.value))}
          rows={4}
        />
      </Field>
      <Field label={t("hint.label")} htmlFor="ac-hint" name="hint">
        <Input
          id="ac-hint"
          value={hint}
          onChange={(e) => onChange(patchParam(params, "hint", e.target.value))}
        />
      </Field>
    </FieldGroup>
  )
}

// ── ai.extract ────────────────────────────────────────────────────────────
export function AiExtractConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.aiExtract")
  const input = readString(params, "input")
  const schemaJson = readString(params, "schemaJson", "{}")
  const hint = readString(params, "hint")
  const requiredStr = Array.isArray(params.required) ? (params.required as string[]).join(", ") : ""
  return (
    <FieldGroup>
      <AiExplicitProviderFields params={params} onChange={onChange} t={t} idPrefix="ae" />
      <Field
        label={t("schemaJson.label")}
        htmlFor="ae-schema"
        hint={t("schemaJson.hint")}
        name="schemaJson"
      >
        <Textarea
          id="ae-schema"
          value={schemaJson}
          onChange={(e) => {
            const next = patchParam(params, "schemaJson", e.target.value) as Record<string, unknown>
            try {
              const parsed = JSON.parse(e.target.value)
              if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                ;(next as Record<string, unknown>).schema = parsed
              }
            } catch {
              // ignore
            }
            onChange(next)
          }}
          rows={5}
          className="font-mono text-xs"
        />
      </Field>
      <Field label={t("input.label")} htmlFor="ae-input" name="input" required>
        <Textarea
          id="ae-input"
          value={input}
          onChange={(e) => onChange(patchParam(params, "input", e.target.value))}
          rows={4}
        />
      </Field>
      <Field
        label={t("required.label")}
        htmlFor="ae-required"
        hint={t("required.hint")}
        name="required"
      >
        <Input
          id="ae-required"
          value={requiredStr}
          placeholder={t("required.placeholder")}
          onChange={(e) =>
            onChange(
              patchParam(
                params,
                "required",
                e.target.value
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean)
              )
            )
          }
        />
      </Field>
      <Field label={t("hint.label")} htmlFor="ae-hint" name="hint">
        <Input
          id="ae-hint"
          value={hint}
          onChange={(e) => onChange(patchParam(params, "hint", e.target.value))}
        />
      </Field>
    </FieldGroup>
  )
}

// ── ai.embed ──────────────────────────────────────────────────────────────
export function AiEmbedConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.aiEmbed")
  const input = readString(params, "input")
  const dimension = readNumber(params, "dimension", 384)
  const provider = readString(params, "provider")
  const model = readString(params, "model")
  const apiKey = readString(params, "apiKey")
  return (
    <FieldGroup>
      <FieldRow>
        <Field label={t("provider.label")} htmlFor="aem-provider" name="provider">
          <Select
            value={provider || undefined}
            onValueChange={(v) => onChange(patchParam(params, "provider", v))}
          >
            <SelectTrigger id="aem-provider">
              <SelectValue placeholder={t("provider.placeholder")} />
            </SelectTrigger>
            <SelectContent>
              {/* i18n-exempt: embedding provider brand name, not UI prose */}
              <SelectItem value="openai">OpenAI</SelectItem>
              {/* i18n-exempt: embedding provider brand name, not UI prose */}
              <SelectItem value="google">Google</SelectItem>
              {/* i18n-exempt: embedding provider brand name, not UI prose */}
              <SelectItem value="cohere">Cohere</SelectItem>
              {/* i18n-exempt: embedding provider brand name, not UI prose */}
              <SelectItem value="mistral">Mistral</SelectItem>
              {/* i18n-exempt: embedding provider brand name, not UI prose */}
              <SelectItem value="transformersjs">Transformers.js (local)</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field label={t("model.label")} htmlFor="aem-model" hint={t("model.hint")} name="model">
          <Input
            id="aem-model"
            value={model}
            onChange={(e) => onChange(patchParam(params, "model", e.target.value))}
            placeholder={t("model.placeholder")}
          />
        </Field>
      </FieldRow>
      <Field label={t("apiKey.label")} htmlFor="aem-key" hint={t("apiKey.hint")} name="apiKey">
        <Input
          id="aem-key"
          type="password"
          value={apiKey}
          onChange={(e) => onChange(patchParam(params, "apiKey", e.target.value))}
        />
      </Field>
      <CredentialRefField
        slot="apiKey"
        id="aem-credential"
        t={t}
        inlineValueSet={apiKey.length > 0}
      />
      <Field
        label={t("input.label")}
        htmlFor="aem-input"
        hint={t("input.hint")}
        name="input"
        required
      >
        <Textarea
          id="aem-input"
          value={input}
          onChange={(e) => onChange(patchParam(params, "input", e.target.value))}
          rows={4}
        />
      </Field>
      <Field
        label={t("dimension.label")}
        htmlFor="aem-dim"
        hint={t("dimension.hint")}
        name="dimension"
      >
        <Input
          id="aem-dim"
          type="number"
          min={32}
          max={4096}
          value={dimension}
          onChange={(e) => onChange(patchParam(params, "dimension", Number(e.target.value) || 384))}
        />
      </Field>
    </FieldGroup>
  )
}

// ── ai.browserModel ──────────────────────────────────────────────────────
export function BrowserModelConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.aiBrowserModel")
  const operation = readString(params, "operation", "infer")
  const task = readString(params, "task", "text-classification") as TransformersTask
  const modelId = readString(params, "modelId")
  const capabilities = getTransformersCapabilities()
  const presets = TRANSFORMERS_MODEL_PRESETS.filter((preset) => preset.task === task)
  const needsModel = operation !== "status" && operation !== "disposeAll"
  const candidateLabels = Array.isArray(params.candidateLabels)
    ? params.candidateLabels.filter((item): item is string => typeof item === "string").join(", ")
    : ""

  return (
    <FieldGroup>
      <div className="text-xs text-muted-foreground" role="status">
        {capabilities.available ? t("runtime.available") : t("runtime.unavailable")}
        {capabilities.webgpu ? ` · ${t("runtime.webgpu")}` : ` · ${t("runtime.wasm")}`}
      </div>
      <Field label={t("operation.label")} htmlFor="abm-operation" name="operation" required>
        <Select
          value={operation}
          onValueChange={(value) => onChange(patchParam(params, "operation", value))}
        >
          <SelectTrigger id="abm-operation">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="infer">{t("operation.infer")}</SelectItem>
            <SelectItem value="preload">{t("operation.preload")}</SelectItem>
            <SelectItem value="status">{t("operation.status")}</SelectItem>
            <SelectItem value="disposeModel">{t("operation.disposeModel")}</SelectItem>
            <SelectItem value="disposeAll">{t("operation.disposeAll")}</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      {needsModel && (
        <>
          <Field label={t("task.label")} htmlFor="abm-task" name="task" required>
            <Select
              value={task}
              onValueChange={(value) => onChange(patchParam(params, "task", value))}
            >
              <SelectTrigger id="abm-task">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {BROWSER_MODEL_TASKS.map((item) => (
                  <SelectItem key={item} value={item}>
                    {t(`tasks.${item}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          {presets.length > 0 && (
            <Field label={t("preset.label")} htmlFor="abm-preset" name="preset">
              <Select
                value={presets.some((preset) => preset.modelId === modelId) ? modelId : undefined}
                onValueChange={(value) => onChange(patchParam(params, "modelId", value))}
              >
                <SelectTrigger id="abm-preset">
                  <SelectValue placeholder={t("preset.placeholder")} />
                </SelectTrigger>
                <SelectContent>
                  {presets.map((preset) => (
                    <SelectItem key={preset.modelId} value={preset.modelId}>
                      {preset.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          )}
          <Field label={t("modelId.label")} htmlFor="abm-model" name="modelId" required>
            <Input
              id="abm-model"
              value={modelId}
              onChange={(event) => onChange(patchParam(params, "modelId", event.target.value))}
              placeholder={t("modelId.placeholder")}
            />
          </Field>
        </>
      )}
      {operation === "infer" && (
        <>
          <Field label={t("input.label")} htmlFor="abm-input" name="input">
            <Textarea
              id="abm-input"
              value={readString(params, "input")}
              onChange={(event) => onChange(patchParam(params, "input", event.target.value))}
              rows={3}
            />
          </Field>
          <Field label={t("inputJson.label")} htmlFor="abm-input-json" name="inputJson">
            <Textarea
              id="abm-input-json"
              value={readString(params, "inputJson")}
              onChange={(event) => onChange(patchParam(params, "inputJson", event.target.value))}
              placeholder={t("inputJson.placeholder")}
              rows={4}
            />
          </Field>
        </>
      )}
      {needsModel && (
        <>
          <FieldRow>
            <Field label={t("device.label")} htmlFor="abm-device" name="device">
              <Select
                value={readString(params, "device", capabilities.recommendedDevice)}
                onValueChange={(value) => onChange(patchParam(params, "device", value))}
              >
                <SelectTrigger id="abm-device">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {/* i18n-exempt: WASM and WebGPU are the runtime backends' own names */}
                  <SelectItem value="wasm">WASM</SelectItem>
                  {/* i18n-exempt: WASM and WebGPU are the runtime backends' own names */}
                  <SelectItem value="webgpu">WebGPU</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <Field label={t("dtype.label")} htmlFor="abm-dtype" name="dtype">
              <Select
                value={readString(params, "dtype", "q8")}
                onValueChange={(value) => onChange(patchParam(params, "dtype", value))}
              >
                <SelectTrigger id="abm-dtype">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {(["q4", "q8", "fp16", "fp32"] as const).map((dtype) => (
                    <SelectItem key={dtype} value={dtype}>
                      {dtype}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
          </FieldRow>
          <Field label={t("cacheEnabled.label")} htmlFor="abm-cache" name="cacheEnabled">
            <Switch
              id="abm-cache"
              checked={readBoolean(params, "cacheEnabled", true)}
              onCheckedChange={(checked) => onChange(patchParam(params, "cacheEnabled", checked))}
            />
          </Field>
          <FieldRow>
            <Field
              label={t("maxCachedModels.label")}
              htmlFor="abm-max-cached"
              name="maxCachedModels"
            >
              <Input
                id="abm-max-cached"
                type="number"
                min={1}
                max={8}
                value={readNumber(params, "maxCachedModels", 2)}
                onChange={(event) =>
                  onChange(
                    patchParam(
                      params,
                      "maxCachedModels",
                      clampNumberInput(event.target.value, 1, 8, 2)
                    )
                  )
                }
              />
            </Field>
            <Field label={t("timeoutMs.label")} htmlFor="abm-timeout" name="timeoutMs">
              <Input
                id="abm-timeout"
                type="number"
                min={1000}
                max={600000}
                value={readNumber(params, "timeoutMs", 120000)}
                onChange={(event) =>
                  onChange(
                    patchParam(
                      params,
                      "timeoutMs",
                      clampNumberInput(event.target.value, 1000, 600000, 120000)
                    )
                  )
                }
              />
            </Field>
          </FieldRow>
        </>
      )}
      {operation === "infer" && (
        <>
          <FieldRow>
            <Field label={t("topK.label")} htmlFor="abm-top-k" name="topK">
              <Input
                id="abm-top-k"
                type="number"
                min={1}
                max={100}
                value={readNumber(params, "topK", 1)}
                onChange={(event) =>
                  onChange(
                    patchParam(params, "topK", clampNumberInput(event.target.value, 1, 100, 1))
                  )
                }
              />
            </Field>
            <Field label={t("maxNewTokens.label")} htmlFor="abm-max-tokens" name="maxNewTokens">
              <Input
                id="abm-max-tokens"
                type="number"
                min={1}
                max={8192}
                value={readNumber(params, "maxNewTokens", 256)}
                onChange={(event) =>
                  onChange(
                    patchParam(
                      params,
                      "maxNewTokens",
                      clampNumberInput(event.target.value, 1, 8192, 256)
                    )
                  )
                }
              />
            </Field>
          </FieldRow>
          <FieldRow>
            <Field label={t("temperature.label")} htmlFor="abm-temperature" name="temperature">
              <Input
                id="abm-temperature"
                type="number"
                min={0}
                max={2}
                step={0.1}
                value={readNumber(params, "temperature", 1)}
                onChange={(event) =>
                  onChange(
                    patchParam(
                      params,
                      "temperature",
                      Math.max(0, Math.min(2, Number(event.target.value) || 0))
                    )
                  )
                }
              />
            </Field>
            <Field label={t("maxLength.label")} htmlFor="abm-max-length" name="maxLength">
              <Input
                id="abm-max-length"
                type="number"
                min={1}
                max={32768}
                value={readNumber(params, "maxLength", 512)}
                onChange={(event) =>
                  onChange(
                    patchParam(
                      params,
                      "maxLength",
                      clampNumberInput(event.target.value, 1, 32768, 512)
                    )
                  )
                }
              />
            </Field>
          </FieldRow>
          <FieldRow>
            <Field label={t("language.label")} htmlFor="abm-language" name="language">
              <Input
                id="abm-language"
                value={readString(params, "language")}
                onChange={(event) => onChange(patchParam(params, "language", event.target.value))}
                placeholder={t("language.placeholder")}
              />
            </Field>
            <Field
              label={t("returnTimestamps.label")}
              htmlFor="abm-timestamps"
              name="returnTimestamps"
            >
              <Select
                value={String(params.returnTimestamps ?? false)}
                onValueChange={(value) =>
                  onChange(
                    patchParam(
                      params,
                      "returnTimestamps",
                      value === "word" ? "word" : value === "true"
                    )
                  )
                }
              >
                <SelectTrigger id="abm-timestamps">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="false">{t("returnTimestamps.none")}</SelectItem>
                  <SelectItem value="true">{t("returnTimestamps.segment")}</SelectItem>
                  <SelectItem value="word">{t("returnTimestamps.word")}</SelectItem>
                </SelectContent>
              </Select>
            </Field>
          </FieldRow>
          <Field label={t("candidateLabels.label")} htmlFor="abm-candidates" name="candidateLabels">
            <Input
              id="abm-candidates"
              value={candidateLabels}
              onChange={(event) =>
                onChange(
                  patchParam(
                    params,
                    "candidateLabels",
                    event.target.value
                      .split(",")
                      .map((item) => item.trim())
                      .filter(Boolean)
                  )
                )
              }
              placeholder={t("candidateLabels.placeholder")}
            />
          </Field>
          <Field
            label={t("hypothesisTemplate.label")}
            htmlFor="abm-hypothesis"
            name="hypothesisTemplate"
          >
            <Input
              id="abm-hypothesis"
              value={readString(params, "hypothesisTemplate")}
              onChange={(event) =>
                onChange(patchParam(params, "hypothesisTemplate", event.target.value))
              }
              placeholder={t("hypothesisTemplate.placeholder")}
            />
          </Field>
        </>
      )}
    </FieldGroup>
  )
}
