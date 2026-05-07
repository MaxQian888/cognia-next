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

import { useMemo, useState } from "react"
import { useLiveQuery } from "dexie-react-hooks"
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
import { Field, FieldGroup, readBoolean, readNumber, readString, patchParam } from "./shared"
import { listCharacters } from "@/lib/db/characters"

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
      <Field label="Adapter" htmlFor="ci-adapter" hint="Adapter instance id, e.g., a Telegram bot.">
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
      >
        <Input
          id="ci-conv"
          value={conversationKey}
          onChange={(e) => onChange(patchParam(params, "conversationKey", e.target.value))}
        />
      </Field>
      <Field label="Character (optional)" htmlFor="ci-char">
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
      <Field label="Character" htmlFor="cm-char">
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
      <Field label="Character" htmlFor="cs-char">
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
      >
        <Textarea
          id="cs-content"
          value={content}
          onChange={(e) => onChange(patchParam(params, "content", e.target.value))}
          rows={4}
          placeholder="Hello, {{ $trigger.payload.userName }}"
        />
      </Field>
      <Field label="Target session id (optional)" htmlFor="cs-session">
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
      <Field label="Team id" htmlFor="tr-team">
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
      <Field label="Twin id" htmlFor="tr-twin">
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
      >
        <Textarea
          id="tr-query"
          value={query}
          onChange={(e) => onChange(patchParam(params, "query", e.target.value))}
          rows={3}
          placeholder="{{ $trigger.payload.text }}"
        />
      </Field>
      <Field label="Top K" htmlFor="tr-topk" hint="Number of chunks to return. Default 6.">
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
      <Field label="Adapter" htmlFor="cs-adapter">
        <Input
          id="cs-adapter"
          value={adapterId}
          onChange={(e) => onChange(patchParam(params, "adapterId", e.target.value))}
          placeholder="telegram_main"
        />
      </Field>
      <Field label="Conversation key" htmlFor="cs-conv">
        <Input
          id="cs-conv"
          value={conversationKey}
          onChange={(e) => onChange(patchParam(params, "conversationKey", e.target.value))}
        />
      </Field>
      <Field label="Message content" htmlFor="cs-content">
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
        <Field label="Provider" htmlFor="ai-provider">
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
        <Field label="Model" htmlFor="ai-model" hint="Provider-specific model id.">
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
      >
        <Input
          id="ai-base"
          value={baseURL}
          onChange={(e) => onChange(patchParam(params, "baseURL", e.target.value))}
          placeholder="https://api.openai.com/v1"
        />
      </Field>
      <Field label="System prompt" htmlFor="ai-system">
        <Textarea
          id="ai-system"
          value={systemPrompt}
          onChange={(e) => onChange(patchParam(params, "systemPrompt", e.target.value))}
          rows={3}
        />
      </Field>
      <Field label="User prompt" htmlFor="ai-user">
        <Textarea
          id="ai-user"
          value={userPrompt}
          onChange={(e) => onChange(patchParam(params, "userPrompt", e.target.value))}
          rows={5}
        />
      </Field>
      <Field
        label="Temperature"
        htmlFor="ai-temp"
        hint="0 = deterministic. Higher values = more variety."
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
      >
        <Textarea
          id="br-cond"
          value={condition}
          onChange={(e) => onChange(patchParam(params, "condition", e.target.value))}
          rows={2}
          placeholder="{{ $node['n_classify'].out.label }} === 'urgent'"
          className="font-mono text-xs"
        />
      </Field>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Truthy label" htmlFor="br-tlabel">
          <Input
            id="br-tlabel"
            value={truthy}
            onChange={(e) => onChange(patchParam(params, "truthyLabel", e.target.value))}
          />
        </Field>
        <Field label="Falsy label" htmlFor="br-flabel">
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
      <Field label="Variable name" htmlFor="sv-name">
        <Input
          id="sv-name"
          value={variable}
          onChange={(e) => onChange(patchParam(params, "variable", e.target.value))}
          placeholder="counter"
        />
      </Field>
      <Field label="Value" htmlFor="sv-value" hint="Expression. Stored on the run's static data.">
        <Textarea
          id="sv-value"
          value={value}
          onChange={(e) => onChange(patchParam(params, "value", e.target.value))}
          rows={2}
          className="font-mono text-xs"
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
      <Field label="Wait mode" htmlFor="w-mode">
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
      <Field label="Method" htmlFor="http-method">
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
      <Field label="URL" htmlFor="http-url" hint="Supports {{ }} expressions.">
        <Input
          id="http-url"
          value={url}
          onChange={(e) => onChange(patchParam(params, "url", e.target.value))}
          placeholder="https://api.example.com/v1/things"
        />
      </Field>
      {method !== "GET" ? (
        <Field label="Body" htmlFor="http-body" hint="Sent as application/json.">
          <Textarea
            id="http-body"
            value={body}
            onChange={(e) => onChange(patchParam(params, "body", e.target.value))}
            rows={4}
            className="font-mono text-xs"
          />
        </Field>
      ) : null}
      <div className="flex items-center justify-between gap-3">
        <Field
          label="Follow redirects"
          htmlFor="http-follow"
          hint="If off, returns the redirect status without following."
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
      >
        <Textarea
          id="tmpl"
          value={template}
          onChange={(e) => onChange(patchParam(params, "template", e.target.value))}
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
      <Field label="Operation" htmlFor="tr-op">
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
      >
        <Textarea
          id="tr-expr"
          value={expression}
          onChange={(e) => onChange(patchParam(params, "expression", e.target.value))}
          rows={3}
          className="font-mono text-xs"
        />
      </Field>
    </FieldGroup>
  )
}

// ── annotation.note ───────────────────────────────────────────────────────
export function NoteConfig({ params, onChange }: ConfigProps) {
  const text = readString(params, "text")
  return (
    <FieldGroup>
      <Field label="Note text" htmlFor="note-text">
        <Textarea
          id="note-text"
          value={text}
          onChange={(e) => onChange(patchParam(params, "text", e.target.value))}
          rows={6}
        />
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
