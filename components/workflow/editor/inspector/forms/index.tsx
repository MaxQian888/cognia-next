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

import { useEffect, useMemo, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
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
import { Field, FieldGroup, readBoolean, readNumber, readString, patchParam } from "./shared"
import { ExpressionField } from "./shared/expression-field"
import { useInspectorExpressionCtx } from "./shared/inspector-context"
import { getWebhookUrl } from "@/lib/workflow/runtime/webhook-bridge"
import { listCharacters } from "@/lib/db/characters"
import { listTeams } from "@/lib/db/teams"
import { listSkills } from "@/lib/db/skills"
import { listMcpServers } from "@/lib/db/mcp-servers"
import { listPlugins } from "@/lib/db/plugins"
import { listAdapterInstances } from "@/lib/db/adapter-instances"
import { listWorkflows } from "@/lib/db/workflows"

type Params = Record<string, unknown>
type ChangeFn = (next: Params) => void

interface ConfigProps {
  params: Params
  onChange: ChangeFn
}

// ── trigger.manual ────────────────────────────────────────────────────────
export function ManualTriggerConfig() {
  return (
    <p className="text-xs text-muted-foreground">
      Fires when you click the Run button in the editor. No additional configuration.
    </p>
  )
}

// ── trigger.cron ──────────────────────────────────────────────────────────
export function CronConfig({ params, onChange }: ConfigProps) {
  const cron = readString(params, "cron", "0 9 * * 1-5")
  const tz = readString(params, "timezone", "")
  return (
    <FieldGroup>
      <Field
        label="Cron expression"
        htmlFor="cron-expr"
        hint="Five fields: minute hour day month weekday. Use *  for any value."
        name="cron"
        required
      >
        <Input
          id="cron-expr"
          value={cron}
          onChange={(e) => onChange(patchParam(params, "cron", e.target.value))}
          placeholder="0 9 * * 1-5"
          className="font-mono"
        />
      </Field>
      <Field
        label="Timezone"
        htmlFor="cron-tz"
        hint="Optional. Defaults to the workflow's timezone setting."
        name="timezone"
      >
        <Input
          id="cron-tz"
          value={tz}
          onChange={(e) => onChange(patchParam(params, "timezone", e.target.value))}
          placeholder="Asia/Shanghai"
        />
      </Field>
    </FieldGroup>
  )
}

// ── trigger.connector.inbound ─────────────────────────────────────────────
export function ConnectorInboundConfig({ params, onChange }: ConfigProps) {
  const adapterId = readString(params, "adapterId")
  const conversationKey = readString(params, "conversationKey")
  const characterId = readString(params, "characterId")
  return (
    <FieldGroup>
      <Field
        label="Adapter"
        htmlFor="ci-adapter"
        hint="Adapter instance id, e.g., a Telegram bot."
        name="adapterId"
        required
      >
        <Input
          id="ci-adapter"
          value={adapterId}
          onChange={(e) => onChange(patchParam(params, "adapterId", e.target.value))}
          placeholder="telegram_main"
        />
      </Field>
      <Field
        label="Conversation key"
        htmlFor="ci-conv"
        hint="Optional. Limit to a specific conversation; empty fires on any."
        name="conversationKey"
      >
        <Input
          id="ci-conv"
          value={conversationKey}
          onChange={(e) => onChange(patchParam(params, "conversationKey", e.target.value))}
        />
      </Field>
      <Field label="Character (optional)" htmlFor="ci-char" name="characterId">
        <CharacterPicker
          id="ci-char"
          value={characterId}
          onChange={(v) => onChange(patchParam(params, "characterId", v))}
        />
      </Field>
    </FieldGroup>
  )
}

// ── trigger.chat.message ──────────────────────────────────────────────────
export function ChatMessageTriggerConfig({ params, onChange }: ConfigProps) {
  const characterId = readString(params, "characterId")
  const sessionId = readString(params, "sessionId")
  return (
    <FieldGroup>
      <Field label="Character" htmlFor="cm-char" name="characterId" required>
        <CharacterPicker
          id="cm-char"
          value={characterId}
          onChange={(v) => onChange(patchParam(params, "characterId", v))}
        />
      </Field>
      <Field
        label="Session id (optional)"
        htmlFor="cm-session"
        hint="Limit to a single chat session. Empty fires on any session for the character."
        name="sessionId"
      >
        <Input
          id="cm-session"
          value={sessionId}
          onChange={(e) => onChange(patchParam(params, "sessionId", e.target.value))}
        />
      </Field>
    </FieldGroup>
  )
}

// ── action.character.send ─────────────────────────────────────────────────
export function CharacterSendConfig({ params, onChange }: ConfigProps) {
  const characterId = readString(params, "characterId")
  const content = readString(params, "content")
  const sessionId = readString(params, "sessionId")
  return (
    <FieldGroup>
      <Field label="Character" htmlFor="cs-char" name="characterId" required>
        <CharacterPicker
          id="cs-char"
          value={characterId}
          onChange={(v) => onChange(patchParam(params, "characterId", v))}
        />
      </Field>
      <Field
        label="Message content"
        htmlFor="cs-content"
        hint="Supports {{ $node['id'].out.field }} expressions."
        name="content"
        required
      >
        <ExpressionField
          id="cs-content"
          value={content}
          onChange={(v) => onChange(patchParam(params, "content", v))}
          multiline
          rows={4}
          placeholder="Hello, {{ $trigger.payload.userName }}"
        />
      </Field>
      <Field label="Target session id (optional)" htmlFor="cs-session" name="sessionId">
        <Input
          id="cs-session"
          value={sessionId}
          onChange={(e) => onChange(patchParam(params, "sessionId", e.target.value))}
        />
      </Field>
    </FieldGroup>
  )
}

// ── action.team.run ───────────────────────────────────────────────────────
export function TeamRunConfig({ params, onChange }: ConfigProps) {
  const teamId = readString(params, "teamId")
  const goal = readString(params, "goal")
  return (
    <FieldGroup>
      <Field label="Team id" htmlFor="tr-team" name="teamId" required>
        <Input
          id="tr-team"
          value={teamId}
          onChange={(e) => onChange(patchParam(params, "teamId", e.target.value))}
          placeholder="team_..."
        />
      </Field>
      <Field
        label="Goal / brief"
        htmlFor="tr-goal"
        hint="What you want the team to accomplish. Forwarded to the lead's planning phase."
        name="goal"
        required
      >
        <Textarea
          id="tr-goal"
          value={goal}
          onChange={(e) => onChange(patchParam(params, "goal", e.target.value))}
          rows={4}
        />
      </Field>
    </FieldGroup>
  )
}

// ── action.skill.invoke ───────────────────────────────────────────────────
export function SkillInvokeConfig({ params, onChange }: ConfigProps) {
  const skillIds = readString(params, "skillIds")
  return (
    <FieldGroup>
      <Field
        label="Skill ids (comma-separated)"
        htmlFor="si-ids"
        hint="The selected skills are appended to the next downstream AI prompt."
        name="skillIds"
        required
      >
        <Input
          id="si-ids"
          value={skillIds}
          onChange={(e) => onChange(patchParam(params, "skillIds", e.target.value))}
          placeholder="skill_writing, skill_research"
        />
      </Field>
    </FieldGroup>
  )
}

// ── action.twin.rag ───────────────────────────────────────────────────────
export function TwinRagConfig({ params, onChange }: ConfigProps) {
  const twinId = readString(params, "twinId")
  const query = readString(params, "query")
  const topK = readNumber(params, "topK", 6)
  return (
    <FieldGroup>
      <Field label="Twin id" htmlFor="tr-twin" name="twinId" required>
        <Input
          id="tr-twin"
          value={twinId}
          onChange={(e) => onChange(patchParam(params, "twinId", e.target.value))}
          placeholder="twin_alex"
        />
      </Field>
      <Field
        label="Query"
        htmlFor="tr-query"
        hint="The text used for vector search. Supports expressions."
        name="query"
        required
      >
        <Textarea
          id="tr-query"
          value={query}
          onChange={(e) => onChange(patchParam(params, "query", e.target.value))}
          rows={3}
          placeholder="{{ $trigger.payload.text }}"
        />
      </Field>
      <Field
        label="Top K"
        htmlFor="tr-topk"
        hint="Number of chunks to return. Default 6."
        name="topK"
      >
        <Input
          id="tr-topk"
          type="number"
          min={1}
          max={50}
          value={topK}
          onChange={(e) => onChange(patchParam(params, "topK", Number(e.target.value) || 1))}
        />
      </Field>
    </FieldGroup>
  )
}

// ── action.connector.send ─────────────────────────────────────────────────
export function ConnectorSendConfig({ params, onChange }: ConfigProps) {
  const adapterId = readString(params, "adapterId")
  const conversationKey = readString(params, "conversationKey")
  const content = readString(params, "content")
  return (
    <FieldGroup>
      <Field label="Adapter" htmlFor="cs-adapter" name="adapterId" required>
        <Input
          id="cs-adapter"
          value={adapterId}
          onChange={(e) => onChange(patchParam(params, "adapterId", e.target.value))}
          placeholder="telegram_main"
        />
      </Field>
      <Field label="Conversation key" htmlFor="cs-conv" name="conversationKey" required>
        <Input
          id="cs-conv"
          value={conversationKey}
          onChange={(e) => onChange(patchParam(params, "conversationKey", e.target.value))}
        />
      </Field>
      <Field label="Message content" htmlFor="cs-content" name="content" required>
        <Textarea
          id="cs-content"
          value={content}
          onChange={(e) => onChange(patchParam(params, "content", e.target.value))}
          rows={4}
        />
      </Field>
    </FieldGroup>
  )
}

// ── ai.prompt ─────────────────────────────────────────────────────────────
export function AiPromptConfig({ params, onChange }: ConfigProps) {
  const provider = readString(params, "provider")
  const model = readString(params, "model")
  const apiKey = readString(params, "apiKey")
  const baseURL = readString(params, "baseURL")
  const systemPrompt = readString(params, "systemPrompt")
  const userPrompt = readString(params, "userPrompt")
  const temperature = readNumber(params, "temperature", 0.7)
  return (
    <FieldGroup>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Provider" htmlFor="ai-provider" name="provider">
          <Select
            value={provider || undefined}
            onValueChange={(v) => onChange(patchParam(params, "provider", v))}
          >
            <SelectTrigger id="ai-provider">
              <SelectValue placeholder="(stub)" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="anthropic">Anthropic</SelectItem>
              <SelectItem value="openai">OpenAI</SelectItem>
              <SelectItem value="google">Google</SelectItem>
              <SelectItem value="mistral">Mistral</SelectItem>
              <SelectItem value="cohere">Cohere</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field label="Model" htmlFor="ai-model" hint="Provider-specific model id." name="model">
          <Input
            id="ai-model"
            value={model}
            onChange={(e) => onChange(patchParam(params, "model", e.target.value))}
            placeholder="claude-sonnet-4-6"
          />
        </Field>
      </div>
      <Field
        label="API key"
        htmlFor="ai-key"
        hint="Embedded inline. For shared workflows, use a credential ref instead."
        name="apiKey"
      >
        <Input
          id="ai-key"
          type="password"
          value={apiKey}
          onChange={(e) => onChange(patchParam(params, "apiKey", e.target.value))}
        />
      </Field>
      <Field
        label="Base URL (optional)"
        htmlFor="ai-base"
        hint="Override for proxies / custom OpenAI-compatible endpoints."
        name="baseURL"
      >
        <Input
          id="ai-base"
          value={baseURL}
          onChange={(e) => onChange(patchParam(params, "baseURL", e.target.value))}
          placeholder="https://api.openai.com/v1"
        />
      </Field>
      <Field label="System prompt" htmlFor="ai-system" name="systemPrompt">
        <ExpressionField
          id="ai-system"
          value={systemPrompt}
          onChange={(v) => onChange(patchParam(params, "systemPrompt", v))}
          multiline
          rows={3}
        />
      </Field>
      <Field label="User prompt" htmlFor="ai-user" name="userPrompt" required>
        <ExpressionField
          id="ai-user"
          value={userPrompt}
          onChange={(v) => onChange(patchParam(params, "userPrompt", v))}
          multiline
          rows={5}
        />
      </Field>
      <Field
        label="Temperature"
        htmlFor="ai-temp"
        hint="0 = deterministic. Higher values = more variety."
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
    </FieldGroup>
  )
}

// ── flow.branch ───────────────────────────────────────────────────────────
export function BranchConfig({ params, onChange }: ConfigProps) {
  const condition = readString(params, "condition")
  const truthy = readString(params, "truthyLabel", "true")
  const falsy = readString(params, "falsyLabel", "false")
  return (
    <FieldGroup>
      <Field
        label="Condition"
        htmlFor="br-cond"
        hint="Expression that resolves to a truthy value. Supports {{ }} expressions."
        name="condition"
        required
      >
        <ExpressionField
          id="br-cond"
          value={condition}
          onChange={(v) => onChange(patchParam(params, "condition", v))}
          multiline
          rows={2}
          placeholder="{{ $node['n_classify'].out.label }} === 'urgent'"
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Truthy label" htmlFor="br-tlabel" name="truthyLabel">
          <Input
            id="br-tlabel"
            value={truthy}
            onChange={(e) => onChange(patchParam(params, "truthyLabel", e.target.value))}
          />
        </Field>
        <Field label="Falsy label" htmlFor="br-flabel" name="falsyLabel">
          <Input
            id="br-flabel"
            value={falsy}
            onChange={(e) => onChange(patchParam(params, "falsyLabel", e.target.value))}
          />
        </Field>
      </div>
    </FieldGroup>
  )
}

// ── flow.set ──────────────────────────────────────────────────────────────
export function SetVariableConfig({ params, onChange }: ConfigProps) {
  const variable = readString(params, "variable")
  const value = readString(params, "value")
  return (
    <FieldGroup>
      <Field label="Variable name" htmlFor="sv-name" name="variable" required>
        <Input
          id="sv-name"
          value={variable}
          onChange={(e) => onChange(patchParam(params, "variable", e.target.value))}
          placeholder="counter"
        />
      </Field>
      <Field
        label="Value"
        htmlFor="sv-value"
        hint="Expression. Stored on the run's static data."
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
  const mode = readString(params, "mode", "duration")
  const durationMs = readNumber(params, "durationMs", 1000)
  return (
    <FieldGroup>
      <Field label="Wait mode" htmlFor="w-mode" name="mode">
        <Select value={mode} onValueChange={(v) => onChange(patchParam(params, "mode", v))}>
          <SelectTrigger id="w-mode">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="duration">Fixed duration</SelectItem>
            <SelectItem value="event">Wait for event (Phase 4+)</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      {mode === "duration" ? (
        <Field
          label="Duration (ms)"
          htmlFor="w-dur"
          hint="The orchestrator pauses the run for this long before continuing."
          name="durationMs"
        >
          <Input
            id="w-dur"
            type="number"
            min={0}
            value={durationMs}
            onChange={(e) =>
              onChange(patchParam(params, "durationMs", Number(e.target.value) || 0))
            }
          />
        </Field>
      ) : null}
    </FieldGroup>
  )
}

// ── io.http ───────────────────────────────────────────────────────────────
export function HttpRequestConfig({ params, onChange }: ConfigProps) {
  const method = readString(params, "method", "GET")
  const url = readString(params, "url")
  const body = readString(params, "body")
  const followRedirects = readBoolean(params, "followRedirects", true)
  return (
    <FieldGroup>
      <Field label="Method" htmlFor="http-method" name="method">
        <Select value={method} onValueChange={(v) => onChange(patchParam(params, "method", v))}>
          <SelectTrigger id="http-method">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="GET">GET</SelectItem>
            <SelectItem value="POST">POST</SelectItem>
            <SelectItem value="PUT">PUT</SelectItem>
            <SelectItem value="PATCH">PATCH</SelectItem>
            <SelectItem value="DELETE">DELETE</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      <Field label="URL" htmlFor="http-url" hint="Supports {{ }} expressions." name="url" required>
        <Input
          id="http-url"
          value={url}
          onChange={(e) => onChange(patchParam(params, "url", e.target.value))}
          placeholder="https://api.example.com/v1/things"
        />
      </Field>
      {method !== "GET" ? (
        <Field label="Body" htmlFor="http-body" hint="Sent as application/json." name="body">
          <ExpressionField
            id="http-body"
            value={body}
            onChange={(v) => onChange(patchParam(params, "body", v))}
            multiline
            rows={4}
          />
        </Field>
      ) : null}
      <div className="flex items-center justify-between gap-3">
        <Field
          label="Follow redirects"
          htmlFor="http-follow"
          hint="If off, returns the redirect status without following."
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
  const code = readString(
    params,
    "code",
    "// upstream is the merged outputs of all parents.\nreturn { result: upstream }"
  )
  return (
    <FieldGroup>
      <Field
        label="JS body"
        htmlFor="code-body"
        hint="Runs in a sandboxed Function() with a 5 s timeout. Available: upstream, params, trigger."
        name="code"
        required
      >
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
  const template = readString(params, "template")
  return (
    <FieldGroup>
      <Field
        label="Template"
        htmlFor="tmpl"
        hint="Mustache-like {{ }} expressions are evaluated against upstream / trigger / static data."
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
  const op = readString(params, "operation", "map")
  const expression = readString(params, "expression")
  return (
    <FieldGroup>
      <Field label="Operation" htmlFor="tr-op" name="operation">
        <Select value={op} onValueChange={(v) => onChange(patchParam(params, "operation", v))}>
          <SelectTrigger id="tr-op">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="map">Map</SelectItem>
            <SelectItem value="filter">Filter</SelectItem>
            <SelectItem value="reduce">Reduce</SelectItem>
            <SelectItem value="sort">Sort</SelectItem>
            <SelectItem value="flatten">Flatten</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      <Field
        label="Expression"
        htmlFor="tr-expr"
        hint="Per-operation expression. For map: 'x.field'. For filter: 'x.value > 0'."
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

// ── annotation.note ───────────────────────────────────────────────────────
const NOTE_COLOR_OPTIONS: Array<{
  value: "yellow" | "green" | "blue" | "pink" | "violet"
  swatch: string
  label: string
}> = [
  { value: "yellow", swatch: "bg-amber-200", label: "Yellow" },
  { value: "green", swatch: "bg-emerald-200", label: "Green" },
  { value: "blue", swatch: "bg-sky-200", label: "Blue" },
  { value: "pink", swatch: "bg-pink-200", label: "Pink" },
  { value: "violet", swatch: "bg-violet-200", label: "Violet" },
]

export function NoteConfig({ params, onChange }: ConfigProps) {
  const text = readString(params, "text")
  const color = readString(params, "color", "yellow")
  return (
    <FieldGroup>
      <Field label="Note text" htmlFor="note-text" name="text">
        <Textarea
          id="note-text"
          value={text}
          onChange={(e) => onChange(patchParam(params, "text", e.target.value))}
          rows={6}
        />
      </Field>
      <Field label="Color" htmlFor="note-color" name="color">
        <div id="note-color" role="radiogroup" aria-label="Note color" className="flex gap-1.5">
          {NOTE_COLOR_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              role="radio"
              aria-checked={color === opt.value}
              aria-label={opt.label}
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
      <Field
        label="Params (JSON)"
        htmlFor="gen-json"
        hint="Edit the raw params object. Invalid JSON is not saved."
      >
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
                setError("Top-level must be a JSON object")
              }
            } catch (err) {
              setError(err instanceof Error ? err.message : "Invalid JSON")
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

// Banner that fetches the live webhook URL for the current node and shows
// it (or a "save first" hint when the trigger hasn't been registered yet).
function WebhookUrlBanner() {
  const ctx = useInspectorExpressionCtx()
  const [url, setUrl] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const triggerId = ctx?.currentNodeId
  useEffect(() => {
    if (!triggerId) return
    let cancelled = false
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPending(true)
    void getWebhookUrl(triggerId)
      .then((u) => {
        if (!cancelled) setUrl(u)
      })
      .finally(() => {
        if (!cancelled) setPending(false)
      })
    return () => {
      cancelled = true
    }
  }, [triggerId])
  return (
    <div className="rounded-md border border-wf-status-running/40 bg-wf-status-running/5 px-2.5 py-2 text-[11px] space-y-1">
      <p className="text-wf-status-running">
        Desktop only. The webhook receiver runs inside the Tauri sidecar.
      </p>
      {url ? (
        <p className="font-mono break-all text-foreground">
          <span className="text-muted-foreground">URL: </span>
          {url}
        </p>
      ) : (
        <p className="text-muted-foreground">
          {pending
            ? "Loading webhook URL…"
            : "Save the workflow to register the webhook and reveal its URL."}
        </p>
      )}
    </div>
  )
}

// ── trigger.webhook ───────────────────────────────────────────────────────
export function WebhookTriggerConfig({ params, onChange }: ConfigProps) {
  const path = readString(params, "path")
  const method = readString(params, "method", "POST")
  const hmacSecret = readString(params, "hmacSecret")
  const responseStatus = readNumber(params, "responseStatus", 200)
  const responseTemplate = readString(params, "responseTemplate")
  return (
    <FieldGroup>
      <WebhookUrlBanner />
      <div className="grid grid-cols-2 gap-3">
        <Field label="Method" htmlFor="wh-method" name="method">
          <Select value={method} onValueChange={(v) => onChange(patchParam(params, "method", v))}>
            <SelectTrigger id="wh-method">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="POST">POST</SelectItem>
              <SelectItem value="GET">GET</SelectItem>
              <SelectItem value="PUT">PUT</SelectItem>
              <SelectItem value="PATCH">PATCH</SelectItem>
              <SelectItem value="DELETE">DELETE</SelectItem>
              <SelectItem value="*">Any</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field
          label="Path"
          htmlFor="wh-path"
          hint="Mounted at /webhook/<path>"
          name="path"
          required
        >
          <Input
            id="wh-path"
            value={path}
            onChange={(e) => onChange(patchParam(params, "path", e.target.value))}
            placeholder="incoming-events"
            className="font-mono text-xs"
          />
        </Field>
      </div>
      <Field
        label="HMAC secret (optional)"
        htmlFor="wh-hmac"
        hint="Verifies the X-Signature-256 header. Leave blank to skip verification."
        name="hmacSecret"
      >
        <Input
          id="wh-hmac"
          type="password"
          value={hmacSecret}
          onChange={(e) => onChange(patchParam(params, "hmacSecret", e.target.value))}
        />
      </Field>
      <div className="grid grid-cols-3 gap-3">
        <Field
          label="Response status"
          htmlFor="wh-status"
          className="col-span-1"
          name="responseStatus"
        >
          <Input
            id="wh-status"
            type="number"
            min={100}
            max={599}
            value={responseStatus}
            onChange={(e) =>
              onChange(patchParam(params, "responseStatus", Number(e.target.value) || 200))
            }
          />
        </Field>
        <Field
          label="Response body template"
          htmlFor="wh-resp"
          hint="Optional. Defaults to the workflow run id."
          className="col-span-2"
          name="responseTemplate"
        >
          <Input
            id="wh-resp"
            value={responseTemplate}
            onChange={(e) => onChange(patchParam(params, "responseTemplate", e.target.value))}
            placeholder='{ "ok": true, "runId": "{{ $run.id }}" }'
            className="font-mono text-xs"
          />
        </Field>
      </div>
    </FieldGroup>
  )
}

// ── action.character.create ───────────────────────────────────────────────
export function CharacterCreateConfig({ params, onChange }: ConfigProps) {
  const name = readString(params, "name")
  const systemPrompt = readString(params, "systemPrompt")
  const description = readString(params, "description")
  const avatarColor = readString(params, "avatarColor")
  const avatarEmoji = readString(params, "avatarEmoji")
  const model = readString(params, "model")
  return (
    <FieldGroup>
      <Field label="Name" htmlFor="cc-name" name="name" required>
        <Input
          id="cc-name"
          value={name}
          onChange={(e) => onChange(patchParam(params, "name", e.target.value))}
          placeholder="Research assistant"
        />
      </Field>
      <Field
        label="System prompt"
        htmlFor="cc-sys"
        hint="Supports {{ }} expressions for dynamic content."
        name="systemPrompt"
        required
      >
        <Textarea
          id="cc-sys"
          value={systemPrompt}
          onChange={(e) => onChange(patchParam(params, "systemPrompt", e.target.value))}
          rows={5}
        />
      </Field>
      <Field label="Description (optional)" htmlFor="cc-desc" name="description">
        <Textarea
          id="cc-desc"
          value={description}
          onChange={(e) => onChange(patchParam(params, "description", e.target.value))}
          rows={2}
        />
      </Field>
      <div className="grid grid-cols-3 gap-3">
        <Field label="Avatar color" htmlFor="cc-color" name="avatarColor">
          <Input
            id="cc-color"
            value={avatarColor}
            onChange={(e) => onChange(patchParam(params, "avatarColor", e.target.value))}
            placeholder="#6d28d9"
          />
        </Field>
        <Field label="Avatar emoji" htmlFor="cc-emoji" name="avatarEmoji">
          <Input
            id="cc-emoji"
            value={avatarEmoji}
            onChange={(e) => onChange(patchParam(params, "avatarEmoji", e.target.value))}
            placeholder="🤖"
          />
        </Field>
        <Field label="Default model (optional)" htmlFor="cc-model" name="model">
          <Input
            id="cc-model"
            value={model}
            onChange={(e) => onChange(patchParam(params, "model", e.target.value))}
            placeholder="claude-sonnet-4-6"
          />
        </Field>
      </div>
    </FieldGroup>
  )
}

// ── action.character.update ───────────────────────────────────────────────
export function CharacterUpdateConfig({ params, onChange }: ConfigProps) {
  const characterId = readString(params, "characterId")
  const patchJson = readString(params, "patchJson")
  return (
    <FieldGroup>
      <Field label="Character" htmlFor="cu-char" name="characterId" required>
        <CharacterPicker
          id="cu-char"
          value={characterId}
          onChange={(v) => {
            const next = patchParam(params, "characterId", v) as Record<string, unknown>
            onChange(next)
          }}
        />
      </Field>
      <Field
        label="Patch (JSON)"
        htmlFor="cu-patch"
        hint='Fields to update. Example: { "systemPrompt": "{{ $node.n_extract.out.text }}" }'
        name="patchJson"
      >
        <Textarea
          id="cu-patch"
          value={patchJson}
          onChange={(e) => {
            const next = patchParam(params, "patchJson", e.target.value) as Record<string, unknown>
            try {
              const parsed = JSON.parse(e.target.value)
              if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                ;(next as Record<string, unknown>).patch = parsed
              }
            } catch {
              // ignore parse errors during typing — `patch` stays whatever it was
            }
            onChange(next)
          }}
          rows={6}
          className="font-mono text-xs"
        />
      </Field>
    </FieldGroup>
  )
}

// ── action.team.create ────────────────────────────────────────────────────
export function TeamCreateConfig({ params, onChange }: ConfigProps) {
  const name = readString(params, "name")
  const description = readString(params, "description")
  const orchestration = readString(params, "orchestration", "round_robin")
  const supervisorCharacterId = readString(params, "supervisorCharacterId")
  const membersJson = readString(params, "membersJson", "[]")
  return (
    <FieldGroup>
      <Field label="Team name" htmlFor="tc-name" name="name" required>
        <Input
          id="tc-name"
          value={name}
          onChange={(e) => onChange(patchParam(params, "name", e.target.value))}
        />
      </Field>
      <Field label="Description" htmlFor="tc-desc" name="description">
        <Textarea
          id="tc-desc"
          value={description}
          onChange={(e) => onChange(patchParam(params, "description", e.target.value))}
          rows={2}
        />
      </Field>
      <Field label="Orchestration" htmlFor="tc-orc" name="orchestration">
        <Select
          value={orchestration}
          onValueChange={(v) => onChange(patchParam(params, "orchestration", v))}
        >
          <SelectTrigger id="tc-orc">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="round_robin">Round robin</SelectItem>
            <SelectItem value="supervisor">Supervisor</SelectItem>
            <SelectItem value="mention_round_robin">Mention round robin</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      {orchestration === "supervisor" ? (
        <Field label="Supervisor character" htmlFor="tc-sup" name="supervisorCharacterId">
          <CharacterPicker
            id="tc-sup"
            value={supervisorCharacterId}
            onChange={(v) => onChange(patchParam(params, "supervisorCharacterId", v))}
          />
        </Field>
      ) : null}
      <Field
        label="Members (JSON array)"
        htmlFor="tc-members"
        hint='[{ "characterId": "...", "role": "researcher" }]'
        name="membersJson"
      >
        <Textarea
          id="tc-members"
          value={membersJson}
          onChange={(e) => {
            const next = patchParam(params, "membersJson", e.target.value) as Record<
              string,
              unknown
            >
            try {
              const parsed = JSON.parse(e.target.value)
              if (Array.isArray(parsed)) (next as Record<string, unknown>).members = parsed
            } catch {
              // ignore
            }
            onChange(next)
          }}
          rows={5}
          className="font-mono text-xs"
        />
      </Field>
    </FieldGroup>
  )
}

// ── action.team.update ────────────────────────────────────────────────────
export function TeamUpdateConfig({ params, onChange }: ConfigProps) {
  const teamId = readString(params, "teamId")
  const patchJson = readString(params, "patchJson")
  return (
    <FieldGroup>
      <Field label="Team" htmlFor="tu-team" name="teamId" required>
        <TeamPicker
          id="tu-team"
          value={teamId}
          onChange={(v) => onChange(patchParam(params, "teamId", v))}
        />
      </Field>
      <Field
        label="Patch (JSON)"
        htmlFor="tu-patch"
        hint='Example: { "orchestration": "supervisor" }'
        name="patchJson"
      >
        <Textarea
          id="tu-patch"
          value={patchJson}
          onChange={(e) => {
            const next = patchParam(params, "patchJson", e.target.value) as Record<string, unknown>
            try {
              const parsed = JSON.parse(e.target.value)
              if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                ;(next as Record<string, unknown>).patch = parsed
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
    </FieldGroup>
  )
}

// ── action.skill.upsert ───────────────────────────────────────────────────
export function SkillUpsertConfig({ params, onChange }: ConfigProps) {
  const skillId = readString(params, "skillId")
  const name = readString(params, "name")
  const description = readString(params, "description")
  const content = readString(params, "content")
  const tagsRaw = readString(params, "tagsRaw")
  return (
    <FieldGroup>
      <Field
        label="Skill id (optional)"
        htmlFor="su-id"
        hint="If set, updates that skill. Otherwise creates a new one."
        name="skillId"
      >
        <SkillPicker
          id="su-id"
          value={skillId}
          onChange={(v) => onChange(patchParam(params, "skillId", v))}
          allowEmpty
        />
      </Field>
      <Field label="Name" htmlFor="su-name" name="name" required>
        <Input
          id="su-name"
          value={name}
          onChange={(e) => onChange(patchParam(params, "name", e.target.value))}
          placeholder="Research framework"
        />
      </Field>
      <Field label="Description" htmlFor="su-desc" name="description">
        <Input
          id="su-desc"
          value={description}
          onChange={(e) => onChange(patchParam(params, "description", e.target.value))}
        />
      </Field>
      <Field
        label="Markdown body"
        htmlFor="su-content"
        hint="The skill body. Supports expressions; rendered into AI prompts when invoked."
        name="content"
        required
      >
        <Textarea
          id="su-content"
          value={content}
          onChange={(e) => onChange(patchParam(params, "content", e.target.value))}
          rows={8}
          className="font-mono text-xs"
        />
      </Field>
      <Field label="Tags" htmlFor="su-tags" hint="Comma separated" name="tagsRaw">
        <Input
          id="su-tags"
          value={tagsRaw}
          onChange={(e) => {
            const next = patchParam(params, "tagsRaw", e.target.value) as Record<string, unknown>
            ;(next as Record<string, unknown>).tags = e.target.value
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean)
            onChange(next)
          }}
          placeholder="research, planning"
        />
      </Field>
    </FieldGroup>
  )
}

// ── action.twin.ingest ────────────────────────────────────────────────────
export function TwinIngestConfig({ params, onChange }: ConfigProps) {
  const twinId = readString(params, "twinId")
  const sourceMode = readString(params, "sourceMode", "paste")
  const format = readString(params, "format", "markdown")
  const content = readString(params, "content")
  const url = readString(params, "url")
  const title = readString(params, "title")
  return (
    <FieldGroup>
      <Field label="Twin id" htmlFor="ti-twin" name="twinId" required>
        <Input
          id="ti-twin"
          value={twinId}
          onChange={(e) => onChange(patchParam(params, "twinId", e.target.value))}
          placeholder="twin_alex"
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Source mode" htmlFor="ti-mode" name="sourceMode">
          <Select
            value={sourceMode}
            onValueChange={(v) => onChange(patchParam(params, "sourceMode", v))}
          >
            <SelectTrigger id="ti-mode">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="paste">Paste content</SelectItem>
              <SelectItem value="fetch">Fetch URL</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field label="Format" htmlFor="ti-fmt" name="format">
          <Select value={format} onValueChange={(v) => onChange(patchParam(params, "format", v))}>
            <SelectTrigger id="ti-fmt">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="markdown">Markdown</SelectItem>
              <SelectItem value="text">Plain text</SelectItem>
              <SelectItem value="code">Code</SelectItem>
              <SelectItem value="chat">Chat export</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      </div>
      <Field label="Title (optional)" htmlFor="ti-title" name="title">
        <Input
          id="ti-title"
          value={title}
          onChange={(e) => onChange(patchParam(params, "title", e.target.value))}
        />
      </Field>
      {sourceMode === "fetch" ? (
        <Field label="URL" htmlFor="ti-url" hint="Supports {{ }} expressions." name="url" required>
          <Input
            id="ti-url"
            value={url}
            onChange={(e) => onChange(patchParam(params, "url", e.target.value))}
            placeholder="https://..."
          />
        </Field>
      ) : (
        <Field
          label="Content"
          htmlFor="ti-content"
          hint="Supports {{ }} expressions."
          name="content"
          required
        >
          <Textarea
            id="ti-content"
            value={content}
            onChange={(e) => onChange(patchParam(params, "content", e.target.value))}
            rows={8}
            className="font-mono text-xs"
          />
        </Field>
      )}
    </FieldGroup>
  )
}

// ── action.mcp.invokeTool ─────────────────────────────────────────────────
export function McpInvokeToolConfig({ params, onChange }: ConfigProps) {
  const serverId = readString(params, "serverId")
  const toolName = readString(params, "toolName")
  const argsJson = readString(params, "argsJson", "{}")
  return (
    <FieldGroup>
      <Field label="MCP server" htmlFor="mi-server" name="serverId" required>
        <McpServerPicker
          id="mi-server"
          value={serverId}
          onChange={(v) => onChange(patchParam(params, "serverId", v))}
        />
      </Field>
      <Field label="Tool name" htmlFor="mi-tool" name="toolName" required>
        <Input
          id="mi-tool"
          value={toolName}
          onChange={(e) => onChange(patchParam(params, "toolName", e.target.value))}
          placeholder="search_repos"
        />
      </Field>
      <Field
        label="Arguments (JSON)"
        htmlFor="mi-args"
        hint="Forwarded as the tool call's arguments. Supports expressions."
        name="argsJson"
      >
        <Textarea
          id="mi-args"
          value={argsJson}
          onChange={(e) => {
            const next = patchParam(params, "argsJson", e.target.value) as Record<string, unknown>
            try {
              const parsed = JSON.parse(e.target.value)
              if (parsed && typeof parsed === "object") {
                ;(next as Record<string, unknown>).args = parsed
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
    </FieldGroup>
  )
}

// ── action.plugin.invoke ──────────────────────────────────────────────────
export function PluginInvokeConfig({ params, onChange }: ConfigProps) {
  const pluginId = readString(params, "pluginId")
  const taskId = readString(params, "taskId")
  const argsJson = readString(params, "argsJson", "{}")
  return (
    <FieldGroup>
      <Field label="Plugin" htmlFor="pi-plug" name="pluginId" required>
        <PluginPicker
          id="pi-plug"
          value={pluginId}
          onChange={(v) => onChange(patchParam(params, "pluginId", v))}
        />
      </Field>
      <Field label="Task id" htmlFor="pi-task" name="taskId" required>
        <Input
          id="pi-task"
          value={taskId}
          onChange={(e) => onChange(patchParam(params, "taskId", e.target.value))}
          placeholder="generate-report"
        />
      </Field>
      <Field
        label="Arguments (JSON)"
        htmlFor="pi-args"
        hint="Forwarded to the plugin task handler."
        name="argsJson"
      >
        <Textarea
          id="pi-args"
          value={argsJson}
          onChange={(e) => {
            const next = patchParam(params, "argsJson", e.target.value) as Record<string, unknown>
            try {
              const parsed = JSON.parse(e.target.value)
              if (parsed && typeof parsed === "object") {
                ;(next as Record<string, unknown>).args = parsed
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
    </FieldGroup>
  )
}

// ── action.connector.draft ────────────────────────────────────────────────
export function ConnectorDraftConfig({ params, onChange }: ConfigProps) {
  const conversationKey = readString(params, "conversationKey")
  const sessionId = readString(params, "sessionId")
  const content = readString(params, "content")
  const sourceMessageId = readString(params, "sourceMessageId")
  const ttlMs = readNumber(params, "ttlMs", 0)
  return (
    <FieldGroup>
      <Field label="Conversation key" htmlFor="cd-conv" name="conversationKey" required>
        <Input
          id="cd-conv"
          value={conversationKey}
          onChange={(e) => onChange(patchParam(params, "conversationKey", e.target.value))}
        />
      </Field>
      <Field label="Session id" htmlFor="cd-session" name="sessionId" required>
        <Input
          id="cd-session"
          value={sessionId}
          onChange={(e) => onChange(patchParam(params, "sessionId", e.target.value))}
        />
      </Field>
      <Field label="Draft content" htmlFor="cd-content" name="content" required>
        <Textarea
          id="cd-content"
          value={content}
          onChange={(e) => onChange(patchParam(params, "content", e.target.value))}
          rows={4}
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Source message id (optional)" htmlFor="cd-src" name="sourceMessageId">
          <Input
            id="cd-src"
            value={sourceMessageId}
            onChange={(e) => onChange(patchParam(params, "sourceMessageId", e.target.value))}
          />
        </Field>
        <Field label="TTL (ms, optional)" htmlFor="cd-ttl" hint="0 = no expiry" name="ttlMs">
          <Input
            id="cd-ttl"
            type="number"
            min={0}
            value={ttlMs}
            onChange={(e) => onChange(patchParam(params, "ttlMs", Number(e.target.value) || 0))}
          />
        </Field>
      </div>
    </FieldGroup>
  )
}

// ── ai.classify ───────────────────────────────────────────────────────────
export function AiClassifyConfig({ params, onChange }: ConfigProps) {
  const provider = readString(params, "provider")
  const model = readString(params, "model")
  const apiKey = readString(params, "apiKey")
  const baseURL = readString(params, "baseURL")
  const input = readString(params, "input")
  const labelsRaw = readString(params, "labelsRaw")
  const hint = readString(params, "hint")
  return (
    <FieldGroup>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Provider" htmlFor="ac-provider" name="provider">
          <Select
            value={provider || undefined}
            onValueChange={(v) => onChange(patchParam(params, "provider", v))}
          >
            <SelectTrigger id="ac-provider">
              <SelectValue placeholder="Provider" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="anthropic">Anthropic</SelectItem>
              <SelectItem value="openai">OpenAI</SelectItem>
              <SelectItem value="google">Google</SelectItem>
              <SelectItem value="mistral">Mistral</SelectItem>
              <SelectItem value="cohere">Cohere</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field label="Model" htmlFor="ac-model" name="model">
          <Input
            id="ac-model"
            value={model}
            onChange={(e) => onChange(patchParam(params, "model", e.target.value))}
            placeholder="claude-haiku-4-5-20251001"
          />
        </Field>
      </div>
      <Field label="API key" htmlFor="ac-key" name="apiKey">
        <Input
          id="ac-key"
          type="password"
          value={apiKey}
          onChange={(e) => onChange(patchParam(params, "apiKey", e.target.value))}
        />
      </Field>
      <Field label="Base URL (optional)" htmlFor="ac-base" name="baseURL">
        <Input
          id="ac-base"
          value={baseURL}
          onChange={(e) => onChange(patchParam(params, "baseURL", e.target.value))}
        />
      </Field>
      <Field
        label="Labels (comma-separated)"
        htmlFor="ac-labels"
        hint="The classifier picks one of these. Order is the deterministic fallback."
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
          placeholder="urgent, normal, spam"
        />
      </Field>
      <Field
        label="Input"
        htmlFor="ac-input"
        hint="Supports {{ }} expressions."
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
      <Field label="Guidance (optional)" htmlFor="ac-hint" name="hint">
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
  const provider = readString(params, "provider")
  const model = readString(params, "model")
  const apiKey = readString(params, "apiKey")
  const baseURL = readString(params, "baseURL")
  const input = readString(params, "input")
  const schemaJson = readString(params, "schemaJson", "{}")
  const hint = readString(params, "hint")
  return (
    <FieldGroup>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Provider" htmlFor="ae-provider" name="provider">
          <Select
            value={provider || undefined}
            onValueChange={(v) => onChange(patchParam(params, "provider", v))}
          >
            <SelectTrigger id="ae-provider">
              <SelectValue placeholder="Provider" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="anthropic">Anthropic</SelectItem>
              <SelectItem value="openai">OpenAI</SelectItem>
              <SelectItem value="google">Google</SelectItem>
              <SelectItem value="mistral">Mistral</SelectItem>
              <SelectItem value="cohere">Cohere</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field label="Model" htmlFor="ae-model" name="model">
          <Input
            id="ae-model"
            value={model}
            onChange={(e) => onChange(patchParam(params, "model", e.target.value))}
          />
        </Field>
      </div>
      <Field label="API key" htmlFor="ae-key" name="apiKey">
        <Input
          id="ae-key"
          type="password"
          value={apiKey}
          onChange={(e) => onChange(patchParam(params, "apiKey", e.target.value))}
        />
      </Field>
      <Field label="Base URL (optional)" htmlFor="ae-base" name="baseURL">
        <Input
          id="ae-base"
          value={baseURL}
          onChange={(e) => onChange(patchParam(params, "baseURL", e.target.value))}
        />
      </Field>
      <Field
        label="Schema (JSON)"
        htmlFor="ae-schema"
        hint='Field → expected type. Example: { "name": "string", "amount": "number" }'
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
      <Field label="Input" htmlFor="ae-input" name="input" required>
        <Textarea
          id="ae-input"
          value={input}
          onChange={(e) => onChange(patchParam(params, "input", e.target.value))}
          rows={4}
        />
      </Field>
      <Field label="Guidance (optional)" htmlFor="ae-hint" name="hint">
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
  const input = readString(params, "input")
  const dimension = readNumber(params, "dimension", 384)
  return (
    <FieldGroup>
      <Field
        label="Input"
        htmlFor="aem-input"
        hint="Supports {{ }} expressions."
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
        label="Dimension"
        htmlFor="aem-dim"
        hint="Phase 4 ships a deterministic hash-based embedder; real semantic embeddings land later."
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

// ── flow.switch ───────────────────────────────────────────────────────────
export function SwitchConfig({ params, onChange }: ConfigProps) {
  const subject = readString(params, "subject")
  const cases = Array.isArray(params.cases)
    ? (params.cases as Array<{ value: unknown; label: string }>)
    : []
  const defaultLabel = readString(params, "defaultLabel", "default")

  function updateCases(next: Array<{ value: unknown; label: string }>) {
    onChange(patchParam(params, "cases", next))
  }

  return (
    <FieldGroup>
      <Field
        label="Subject"
        htmlFor="sw-subject"
        hint="Expression evaluated and matched against cases."
        name="subject"
        required
      >
        <Textarea
          id="sw-subject"
          value={subject}
          onChange={(e) => onChange(patchParam(params, "subject", e.target.value))}
          rows={2}
          className="font-mono text-xs"
          placeholder="{{ $node['n_classify'].out.label }}"
        />
      </Field>
      <Field
        label="Cases"
        htmlFor="sw-cases"
        hint="First match wins. Strict equality."
        name="cases"
        required
      >
        <div className="space-y-2">
          {cases.map((c, i) => (
            <div key={i} className="flex gap-2 items-start">
              <Input
                value={typeof c.value === "string" ? c.value : JSON.stringify(c.value)}
                onChange={(e) => {
                  const next = [...cases]
                  next[i] = { ...c, value: e.target.value }
                  updateCases(next)
                }}
                placeholder="value"
              />
              <Input
                value={c.label}
                onChange={(e) => {
                  const next = [...cases]
                  next[i] = { ...c, label: e.target.value }
                  updateCases(next)
                }}
                placeholder="label"
              />
              <Button
                type="button"
                size="icon"
                variant="ghost"
                onClick={() => updateCases(cases.filter((_, j) => j !== i))}
                aria-label="Remove case"
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          ))}
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => updateCases([...cases, { value: "", label: "" }])}
          >
            <Plus className="size-3.5 mr-1" /> Add case
          </Button>
        </div>
      </Field>
      <Field label="Default label" htmlFor="sw-default" name="defaultLabel">
        <Input
          id="sw-default"
          value={defaultLabel}
          onChange={(e) => onChange(patchParam(params, "defaultLabel", e.target.value))}
        />
      </Field>
    </FieldGroup>
  )
}

// ── flow.split ────────────────────────────────────────────────────────────
export function SplitConfig({ params, onChange }: ConfigProps) {
  const labels = Array.isArray(params.branchLabels) ? (params.branchLabels as string[]) : ["A", "B"]

  function updateLabels(next: string[]) {
    onChange(patchParam(params, "branchLabels", next))
  }

  return (
    <FieldGroup>
      <Field
        label="Branch labels"
        htmlFor="sp-labels"
        hint="Each label corresponds to one outgoing edge from this split."
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
                placeholder={`Branch ${i + 1}`}
              />
              <Button
                type="button"
                size="icon"
                variant="ghost"
                onClick={() => updateLabels(labels.filter((_, j) => j !== i))}
                aria-label="Remove branch"
              >
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          ))}
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => updateLabels([...labels, `Branch ${labels.length + 1}`])}
          >
            <Plus className="size-3.5 mr-1" /> Add branch
          </Button>
        </div>
      </Field>
    </FieldGroup>
  )
}

// ── flow.join ─────────────────────────────────────────────────────────────
export function JoinConfig({ params, onChange }: ConfigProps) {
  const joinPolicy = readString(params, "joinPolicy", "all")
  const timeoutMs = readNumber(params, "timeoutMs", 0)
  return (
    <FieldGroup>
      <Field label="Join policy" htmlFor="jn-policy" name="joinPolicy">
        <Select
          value={joinPolicy}
          onValueChange={(v) => onChange(patchParam(params, "joinPolicy", v))}
        >
          <SelectTrigger id="jn-policy">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All — wait for every parent</SelectItem>
            <SelectItem value="any">Any — proceed when any parent succeeds</SelectItem>
            <SelectItem value="race">Race — first parent&apos;s output wins</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      <Field
        label="Timeout (ms, optional)"
        htmlFor="jn-timeout"
        hint="0 = wait forever. Otherwise abort the join after this long."
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
    </FieldGroup>
  )
}

// ── flow.loop ─────────────────────────────────────────────────────────────
export function LoopConfig({ params, onChange }: ConfigProps) {
  const mode = readString(params, "mode", "forEach")
  const times = readNumber(params, "times", 1)
  const inputExpr = readString(params, "inputExpression")
  const bodyExpr = readString(params, "bodyExpression")
  const whileCondition = readString(params, "whileCondition")
  const maxIterations = readNumber(params, "maxIterations", 10000)
  return (
    <FieldGroup>
      <Field label="Mode" htmlFor="lp-mode" name="mode">
        <Select value={mode} onValueChange={(v) => onChange(patchParam(params, "mode", v))}>
          <SelectTrigger id="lp-mode">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="forEach">For each item in array</SelectItem>
            <SelectItem value="times">Repeat N times</SelectItem>
            <SelectItem value="while">While condition is truthy</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      {mode === "times" ? (
        <Field label="Times" htmlFor="lp-times" name="times" required>
          <Input
            id="lp-times"
            type="number"
            min={0}
            value={times}
            onChange={(e) => onChange(patchParam(params, "times", Number(e.target.value) || 0))}
          />
        </Field>
      ) : null}
      {mode === "forEach" ? (
        <Field
          label="Input expression"
          htmlFor="lp-input"
          hint="Resolves to the array to iterate. If empty, the first upstream output is used."
          name="inputExpression"
          required
        >
          <Textarea
            id="lp-input"
            value={inputExpr}
            onChange={(e) => onChange(patchParam(params, "inputExpression", e.target.value))}
            rows={2}
            className="font-mono text-xs"
            placeholder="{{ $node['n_search'].out.results }}"
          />
        </Field>
      ) : null}
      {mode === "while" ? (
        <Field
          label="While condition"
          htmlFor="lp-while"
          hint="Re-evaluated each iteration. Loop ends when this is falsy or maxIterations is reached."
          name="whileCondition"
          required
        >
          <Textarea
            id="lp-while"
            value={whileCondition}
            onChange={(e) => onChange(patchParam(params, "whileCondition", e.target.value))}
            rows={2}
            className="font-mono text-xs"
          />
        </Field>
      ) : null}
      <Field
        label="Body expression"
        htmlFor="lp-body"
        hint="Per-iteration value. $item is the current array element (forEach mode)."
        name="bodyExpression"
        required
      >
        <Textarea
          id="lp-body"
          value={bodyExpr}
          onChange={(e) => onChange(patchParam(params, "bodyExpression", e.target.value))}
          rows={2}
          className="font-mono text-xs"
          placeholder="$item.name"
        />
      </Field>
      <Field
        label="Max iterations"
        htmlFor="lp-max"
        hint="Hard cap. Loop breaks early at this count."
        name="maxIterations"
      >
        <Input
          id="lp-max"
          type="number"
          min={1}
          max={1000000}
          value={maxIterations}
          onChange={(e) =>
            onChange(patchParam(params, "maxIterations", Number(e.target.value) || 10000))
          }
        />
      </Field>
    </FieldGroup>
  )
}

// ── flow.subworkflow ──────────────────────────────────────────────────────
export function SubworkflowConfig({ params, onChange }: ConfigProps) {
  const workflowId = readString(params, "workflowId")
  const inputJson = readString(params, "inputJson", "{}")
  return (
    <FieldGroup>
      <Field label="Sub workflow" htmlFor="sw-wf" name="workflowId" required>
        <SubworkflowPicker
          id="sw-wf"
          value={workflowId}
          onChange={(v) => onChange(patchParam(params, "workflowId", v))}
        />
      </Field>
      <Field
        label="Input (JSON)"
        htmlFor="sw-input"
        hint="Forwarded as the subworkflow's trigger payload."
        name="inputJson"
      >
        <Textarea
          id="sw-input"
          value={inputJson}
          onChange={(e) => {
            const next = patchParam(params, "inputJson", e.target.value) as Record<string, unknown>
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
    </FieldGroup>
  )
}

// ── io.webhook.respond ────────────────────────────────────────────────────
export function WebhookRespondConfig({ params, onChange }: ConfigProps) {
  const status = readNumber(params, "status", 200)
  const headersJson = readString(params, "headersJson", "{}")
  const body = readString(params, "body")
  return (
    <FieldGroup>
      <p className="text-[11px] text-wf-status-running">
        Desktop only. Respond is delivered via the Tauri webhook router.
      </p>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Status code" htmlFor="wr-status" name="status">
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
          label="Headers (JSON)"
          htmlFor="wr-headers"
          hint='Example: { "Content-Type": "application/json" }'
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
            placeholder='{ "Content-Type": "application/json" }'
            className="font-mono text-xs"
          />
        </Field>
      </div>
      <Field label="Body" htmlFor="wr-body" hint="Supports {{ }} expressions." name="body">
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

// ── annotation.group ──────────────────────────────────────────────────────
export function GroupAnnotationConfig({ params, onChange }: ConfigProps) {
  const title = readString(params, "title")
  const color = readString(params, "color", "zinc")
  const width = readNumber(params, "width", 480)
  const height = readNumber(params, "height", 320)
  return (
    <FieldGroup>
      <Field label="Title" htmlFor="grp-title" name="title">
        <Input
          id="grp-title"
          value={title}
          onChange={(e) => onChange(patchParam(params, "title", e.target.value))}
          placeholder="Validation pipeline"
        />
      </Field>
      <Field label="Color token" htmlFor="grp-color" name="color">
        <Select value={color} onValueChange={(v) => onChange(patchParam(params, "color", v))}>
          <SelectTrigger id="grp-color">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="zinc">Zinc</SelectItem>
            <SelectItem value="emerald">Emerald</SelectItem>
            <SelectItem value="sky">Sky</SelectItem>
            <SelectItem value="violet">Violet</SelectItem>
            <SelectItem value="amber">Amber</SelectItem>
            <SelectItem value="rose">Rose</SelectItem>
            <SelectItem value="cyan">Cyan</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Width (px)" htmlFor="grp-w" name="width">
          <Input
            id="grp-w"
            type="number"
            min={200}
            value={width}
            onChange={(e) => onChange(patchParam(params, "width", Number(e.target.value) || 480))}
          />
        </Field>
        <Field label="Height (px)" htmlFor="grp-h" name="height">
          <Input
            id="grp-h"
            type="number"
            min={100}
            value={height}
            onChange={(e) => onChange(patchParam(params, "height", Number(e.target.value) || 320))}
          />
        </Field>
      </div>
    </FieldGroup>
  )
}

// ── Picker helpers ────────────────────────────────────────────────────────
function CharacterPicker({
  id,
  value,
  onChange,
}: {
  id: string
  value: string
  onChange: (v: string) => void
}) {
  const characters = useLiveQuery(() => listCharacters(), [])
  const options = useMemo(
    () => characters?.map((c) => ({ value: c.id, label: c.name })) ?? [],
    [characters]
  )
  return (
    <Select value={value || undefined} onValueChange={onChange}>
      <SelectTrigger id={id}>
        <SelectValue placeholder="Select a character" />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function TeamPicker({
  id,
  value,
  onChange,
}: {
  id: string
  value: string
  onChange: (v: string) => void
}) {
  const teams = useLiveQuery(() => listTeams(), [])
  const options = useMemo(() => teams?.map((t) => ({ value: t.id, label: t.name })) ?? [], [teams])
  return (
    <Select value={value || undefined} onValueChange={onChange}>
      <SelectTrigger id={id}>
        <SelectValue placeholder="Select a team" />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function SkillPicker({
  id,
  value,
  onChange,
  allowEmpty = false,
}: {
  id: string
  value: string
  onChange: (v: string) => void
  allowEmpty?: boolean
}) {
  const skills = useLiveQuery(() => listSkills(), [])
  const options = useMemo(
    () => skills?.map((s) => ({ value: s.id, label: s.name })) ?? [],
    [skills]
  )
  return (
    <Select value={value || undefined} onValueChange={(v) => onChange(v === "__none__" ? "" : v)}>
      <SelectTrigger id={id}>
        <SelectValue placeholder={allowEmpty ? "Create new" : "Select a skill"} />
      </SelectTrigger>
      <SelectContent>
        {allowEmpty ? <SelectItem value="__none__">— create new —</SelectItem> : null}
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function McpServerPicker({
  id,
  value,
  onChange,
}: {
  id: string
  value: string
  onChange: (v: string) => void
}) {
  const servers = useLiveQuery(() => listMcpServers(), [])
  const options = useMemo(
    () =>
      servers?.map((s) => ({
        value: s.id,
        label: s.name ?? s.id,
      })) ?? [],
    [servers]
  )
  return (
    <Select value={value || undefined} onValueChange={onChange}>
      <SelectTrigger id={id}>
        <SelectValue placeholder="Select an MCP server" />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function PluginPicker({
  id,
  value,
  onChange,
}: {
  id: string
  value: string
  onChange: (v: string) => void
}) {
  const plugins = useLiveQuery(() => listPlugins(), [])
  const options = useMemo(
    () =>
      plugins?.map((p) => ({
        value: p.id,
        label: p.name ?? p.id,
      })) ?? [],
    [plugins]
  )
  return (
    <Select value={value || undefined} onValueChange={onChange}>
      <SelectTrigger id={id}>
        <SelectValue placeholder="Select a plugin" />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

function SubworkflowPicker({
  id,
  value,
  onChange,
}: {
  id: string
  value: string
  onChange: (v: string) => void
}) {
  const workflows = useLiveQuery(() => listWorkflows(), [])
  const options = useMemo(
    () => workflows?.map((w) => ({ value: w.id, label: w.name })) ?? [],
    [workflows]
  )
  return (
    <Select value={value || undefined} onValueChange={onChange}>
      <SelectTrigger id={id}>
        <SelectValue placeholder="Select a workflow" />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value} value={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}

// Suppress unused-import warnings when only one of these helpers is exercised
// in a given form's tests. They're real call sites in production.
void listAdapterInstances
