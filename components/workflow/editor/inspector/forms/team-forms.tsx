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
import { DurationField } from "./shared/duration-field"
import { CharacterPicker, TeamPicker, TwinPicker } from "./shared/entity-picker"
import { TypedOutputFields } from "./output-schema-field"
import { PET_INTERACTION_KINDS, PiiGateField, clampNumberInput } from "./form-support"
import type { ConfigProps } from "./form-support"

/**
 * Mirrors `DEFAULT_TIMEOUT_MS` in `lib/workflow/nodes/actions/agent-turn.ts`.
 * Duplicated rather than imported so the inspector bundle does not pull the
 * executor (and its sidecar imports) into the editor chunk.
 */
const AGENT_TURN_DEFAULT_TIMEOUT_MS = 600_000

// ── action.character.send ─────────────────────────────────────────────────
export function CharacterSendConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.characterSend")
  const characterId = readString(params, "characterId")
  const content = readString(params, "content")
  const sessionId = readString(params, "sessionId")
  return (
    <FieldGroup>
      <Field label={t("character.label")} htmlFor="cs-char" name="characterId" required>
        <CharacterPicker
          id="cs-char"
          value={characterId}
          onChange={(v) => onChange(patchParam(params, "characterId", v))}
        />
      </Field>
      <Field
        label={t("content.label")}
        htmlFor="cs-content"
        hint={t("content.hint")}
        name="content"
        required
      >
        <ExpressionField
          id="cs-content"
          value={content}
          onChange={(v) => onChange(patchParam(params, "content", v))}
          multiline
          rows={4}
          placeholder={t("content.placeholder")}
        />
      </Field>
      <Field label={t("sessionId.label")} htmlFor="cs-session" name="sessionId">
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
  const t = useTranslations("workflows.forms.teamRun")
  const teamId = readString(params, "teamId")
  const goal = readString(params, "goal")
  return (
    <FieldGroup>
      <Field label={t("teamId.label")} htmlFor="tr-team" name="teamId" required>
        <TeamPicker
          id="tr-team"
          value={teamId}
          onChange={(v) => onChange(patchParam(params, "teamId", v))}
        />
      </Field>
      <Field label={t("goal.label")} htmlFor="tr-goal" hint={t("goal.hint")} name="goal" required>
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

// ── action.team.reconcile ─────────────────────────────────────────────────
export function TeamReconcileConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.teamReconcile")
  const mode = readString(params, "mode")
  const selectStrategy = readString(params, "selectStrategy")
  const retain = readString(params, "retain")
  const enumField = (
    key: "mode" | "selectStrategy" | "retain",
    value: string,
    options: string[]
  ) => (
    <Field key={key} label={t(`${key}.label`)} htmlFor={`trc-${key}`} name={key}>
      <Select
        value={value || "inherit"}
        onValueChange={(v) => onChange(patchParam(params, key, v === "inherit" ? undefined : v))}
      >
        <SelectTrigger id={`trc-${key}`}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="inherit">{t("inherit")}</SelectItem>
          {options.map((o) => (
            <SelectItem key={o} value={o}>
              {t(`${key}.options.${o}`)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </Field>
  )
  return (
    <FieldGroup>
      <p className="text-xs text-muted-foreground">{t("intro")}</p>
      {enumField("mode", mode, ["manual", "merge-all", "select", "pipeline"])}
      {enumField("selectStrategy", selectStrategy, ["manual", "first-success", "judge"])}
      {enumField("retain", retain, ["all", "keep-winner", "prune-losers"])}
    </FieldGroup>
  )
}

// ── action.team.compose ───────────────────────────────────────────────────
export function TeamComposeConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.teamCompose")
  const objective = readString(params, "objective")
  const name = readString(params, "name")
  const preferredPattern = readString(params, "preferredPattern")
  const maxRoster = readNumber(params, "maxRoster", 0)
  const autoStart = readBoolean(params, "autoStart", false)
  const ultracode = readBoolean(params, "ultracode", false)
  return (
    <FieldGroup>
      <Field
        label={t("objective.label")}
        htmlFor="tco-objective"
        hint={t("objective.hint")}
        name="objective"
        required
      >
        <ExpressionField
          id="tco-objective"
          value={objective}
          onChange={(v) => onChange(patchParam(params, "objective", v))}
          multiline
        />
      </Field>
      <Field label={t("name.label")} htmlFor="tco-name" name="name">
        <Input
          id="tco-name"
          value={name}
          onChange={(e) => onChange(patchParam(params, "name", e.target.value))}
        />
      </Field>
      <Field label={t("preferredPattern.label")} htmlFor="tco-pattern" name="preferredPattern">
        <Select
          value={preferredPattern || "auto"}
          onValueChange={(v) =>
            onChange(patchParam(params, "preferredPattern", v === "auto" ? undefined : v))
          }
        >
          <SelectTrigger id="tco-pattern">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="auto">{t("preferredPattern.options.auto")}</SelectItem>
            <SelectItem value="manager_worker">
              {t("preferredPattern.options.manager_worker")}
            </SelectItem>
            <SelectItem value="parallel_specialists">
              {t("preferredPattern.options.parallel_specialists")}
            </SelectItem>
            <SelectItem value="background_handoff">
              {t("preferredPattern.options.background_handoff")}
            </SelectItem>
            <SelectItem value="external_handoff">
              {t("preferredPattern.options.external_handoff")}
            </SelectItem>
            <SelectItem value="single_agent_recommended">
              {t("preferredPattern.options.single_agent_recommended")}
            </SelectItem>
            <SelectItem value="ultracode_orchestration">
              {t("preferredPattern.options.ultracode_orchestration")}
            </SelectItem>
          </SelectContent>
        </Select>
      </Field>
      <Field label={t("maxRoster.label")} htmlFor="tco-roster" name="maxRoster">
        <Input
          id="tco-roster"
          type="number"
          min={1}
          max={16}
          value={maxRoster > 0 ? maxRoster : ""}
          onChange={(e) => {
            const raw = e.target.value.trim()
            onChange(
              patchParam(
                params,
                "maxRoster",
                raw === "" ? undefined : clampNumberInput(raw, 1, 16, 6)
              )
            )
          }}
        />
      </Field>
      <Field
        label={t("autoStart.label")}
        htmlFor="tco-start"
        hint={t("autoStart.hint")}
        name="autoStart"
      >
        <Switch
          id="tco-start"
          checked={autoStart}
          onCheckedChange={(v) => onChange(patchParam(params, "autoStart", v))}
        />
      </Field>
      {autoStart ? (
        <Field label={t("ultracode.label")} htmlFor="tco-ultra" name="ultracode">
          <Switch
            id="tco-ultra"
            checked={ultracode}
            onCheckedChange={(v) => onChange(patchParam(params, "ultracode", v))}
          />
        </Field>
      ) : null}
    </FieldGroup>
  )
}

// ── action.team.status ────────────────────────────────────────────────────
export function TeamStatusConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.teamStatus")
  const teamId = readString(params, "teamId")
  const includeTasks = readBoolean(params, "includeTasks", true)
  const includeTeammates = readBoolean(params, "includeTeammates", true)
  const includeDelegations = readBoolean(params, "includeDelegations", false)
  return (
    <FieldGroup>
      <Field label={t("teamId.label")} htmlFor="tst-team" name="teamId" required>
        <TeamPicker
          id="tst-team"
          value={teamId}
          onChange={(v) => onChange(patchParam(params, "teamId", v))}
        />
      </Field>
      <Field label={t("includeTasks.label")} htmlFor="tst-tasks" name="includeTasks">
        <Switch
          id="tst-tasks"
          checked={includeTasks}
          onCheckedChange={(v) => onChange(patchParam(params, "includeTasks", v))}
        />
      </Field>
      <Field label={t("includeTeammates.label")} htmlFor="tst-mates" name="includeTeammates">
        <Switch
          id="tst-mates"
          checked={includeTeammates}
          onCheckedChange={(v) => onChange(patchParam(params, "includeTeammates", v))}
        />
      </Field>
      <Field label={t("includeDelegations.label")} htmlFor="tst-dels" name="includeDelegations">
        <Switch
          id="tst-dels"
          checked={includeDelegations}
          onCheckedChange={(v) => onChange(patchParam(params, "includeDelegations", v))}
        />
      </Field>
    </FieldGroup>
  )
}

// ── action.team.delegate ──────────────────────────────────────────────────
export function TeamDelegateConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.teamDelegate")
  const teamId = readString(params, "teamId")
  const target = readString(params, "target", "background")
  const prompt = readString(params, "prompt")
  const systemPrompt = readString(params, "systemPrompt")
  const reason = readString(params, "reason")
  const twinId = readString(params, "twinId")
  const targetTeamId = readString(params, "targetTeamId")
  const targetAgentId = readString(params, "targetAgentId")
  const awaitCompletion = readBoolean(params, "awaitCompletion", true)
  const force = readBoolean(params, "force", false)
  return (
    <FieldGroup>
      <Field label={t("teamId.label")} htmlFor="td-team" name="teamId" required>
        <TeamPicker
          id="td-team"
          value={teamId}
          onChange={(v) => onChange(patchParam(params, "teamId", v))}
        />
      </Field>
      <Field label={t("target.label")} htmlFor="td-target" name="target" required>
        <Select value={target} onValueChange={(v) => onChange(patchParam(params, "target", v))}>
          <SelectTrigger id="td-target">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="twin">{t("target.options.twin")}</SelectItem>
            <SelectItem value="background">{t("target.options.background")}</SelectItem>
            <SelectItem value="external">{t("target.options.external")}</SelectItem>
            <SelectItem value="team">{t("target.options.team")}</SelectItem>
          </SelectContent>
        </Select>
      </Field>
      {target === "twin" ? (
        <Field label={t("twinId.label")} htmlFor="td-twin" name="twinId" required>
          <TwinPicker
            id="td-twin"
            value={twinId}
            onChange={(v) => onChange(patchParam(params, "twinId", v))}
          />
        </Field>
      ) : null}
      {target === "team" ? (
        <Field label={t("targetTeamId.label")} htmlFor="td-tteam" name="targetTeamId" required>
          <TeamPicker
            id="td-tteam"
            value={targetTeamId}
            onChange={(v) => onChange(patchParam(params, "targetTeamId", v))}
          />
        </Field>
      ) : null}
      {target === "external" ? (
        <Field
          label={t("targetAgentId.label")}
          htmlFor="td-tagent"
          hint={t("targetAgentId.hint")}
          name="targetAgentId"
          required
        >
          <Input
            id="td-tagent"
            value={targetAgentId}
            onChange={(e) => onChange(patchParam(params, "targetAgentId", e.target.value))}
          />
        </Field>
      ) : null}
      {target !== "team" ? (
        <Field label={t("prompt.label")} htmlFor="td-prompt" name="prompt" required>
          <ExpressionField
            id="td-prompt"
            value={prompt}
            onChange={(v) => onChange(patchParam(params, "prompt", v))}
            multiline
          />
        </Field>
      ) : null}
      {target !== "team" ? (
        <Field label={t("systemPrompt.label")} htmlFor="td-system" name="systemPrompt">
          <Textarea
            id="td-system"
            value={systemPrompt}
            onChange={(e) => onChange(patchParam(params, "systemPrompt", e.target.value))}
            rows={3}
          />
        </Field>
      ) : null}
      <Field label={t("reason.label")} htmlFor="td-reason" name="reason">
        <Input
          id="td-reason"
          value={reason}
          onChange={(e) => onChange(patchParam(params, "reason", e.target.value))}
        />
      </Field>
      <Field
        label={t("awaitCompletion.label")}
        htmlFor="td-await"
        hint={t("awaitCompletion.hint")}
        name="awaitCompletion"
      >
        <Switch
          id="td-await"
          checked={awaitCompletion}
          onCheckedChange={(v) => onChange(patchParam(params, "awaitCompletion", v))}
        />
      </Field>
      <Field label={t("force.label")} htmlFor="td-force" hint={t("force.hint")} name="force">
        <Switch
          id="td-force"
          checked={force}
          onCheckedChange={(v) => onChange(patchParam(params, "force", v))}
        />
      </Field>
    </FieldGroup>
  )
}

// ── action.team.message ───────────────────────────────────────────────────
export function TeamMessageConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.teamMessage")
  const teamId = readString(params, "teamId")
  const content = readString(params, "content")
  const senderId = readString(params, "senderId")
  const recipientId = readString(params, "recipientId")
  const taskId = readString(params, "taskId")
  return (
    <FieldGroup>
      <Field label={t("teamId.label")} htmlFor="tm-team" name="teamId" required>
        <TeamPicker
          id="tm-team"
          value={teamId}
          onChange={(v) => onChange(patchParam(params, "teamId", v))}
        />
      </Field>
      <Field label={t("content.label")} htmlFor="tm-content" name="content" required>
        <ExpressionField
          id="tm-content"
          value={content}
          onChange={(v) => onChange(patchParam(params, "content", v))}
          multiline
        />
      </Field>
      <Field
        label={t("senderId.label")}
        htmlFor="tm-sender"
        hint={t("senderId.hint")}
        name="senderId"
      >
        <Input
          id="tm-sender"
          value={senderId}
          onChange={(e) => onChange(patchParam(params, "senderId", e.target.value))}
        />
      </Field>
      <Field label={t("recipientId.label")} htmlFor="tm-recipient" name="recipientId">
        <Input
          id="tm-recipient"
          value={recipientId}
          onChange={(e) => onChange(patchParam(params, "recipientId", e.target.value))}
        />
      </Field>
      <Field label={t("taskId.label")} htmlFor="tm-task" name="taskId">
        <Input
          id="tm-task"
          value={taskId}
          onChange={(e) => onChange(patchParam(params, "taskId", e.target.value))}
        />
      </Field>
    </FieldGroup>
  )
}

// ── action.agent.turn ─────────────────────────────────────────────────────
export function AgentTurnConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.agentTurn")
  const prompt = readString(params, "prompt")
  const characterId = readString(params, "characterId")
  const systemPrompt = readString(params, "systemPrompt")
  const model = readString(params, "model")
  const allowedTools = Array.isArray(params.allowedTools)
    ? (params.allowedTools as string[]).join(", ")
    : ""
  const maxTurns = readNumber(params, "maxTurns", 10)
  const toolsEnabled = readBoolean(params, "toolsEnabled", true)
  const requireTools = readBoolean(params, "requireTools", false)
  const cwd = readString(params, "cwd")
  const piiGate = readString(params, "piiGate", "block")
  // Absent `temperature` means "whatever the provider defaults to" — the
  // executor forwards `undefined` untouched — so the box stays empty rather
  // than inventing a number the node is not actually sending.
  const temperature = typeof params.temperature === "number" ? String(params.temperature) : ""
  // `timeoutMs` does have a concrete executor fallback, so show it.
  const timeoutMs = readNumber(params, "timeoutMs", AGENT_TURN_DEFAULT_TIMEOUT_MS)
  return (
    <FieldGroup>
      <Field label={t("prompt.label")} htmlFor="at-prompt" name="prompt" required>
        <ExpressionField
          id="at-prompt"
          value={prompt}
          onChange={(v) => onChange(patchParam(params, "prompt", v))}
          multiline
          rows={4}
        />
      </Field>
      <Field
        label={t("characterId.label")}
        htmlFor="at-char"
        hint={t("characterId.hint")}
        name="characterId"
      >
        <CharacterPicker
          id="at-char"
          value={characterId}
          onChange={(v) => onChange(patchParam(params, "characterId", v))}
        />
      </Field>
      {!characterId ? (
        <>
          <Field
            label={t("systemPrompt.label")}
            htmlFor="at-system"
            hint={t("systemPrompt.hint")}
            name="systemPrompt"
          >
            <ExpressionField
              id="at-system"
              value={systemPrompt}
              onChange={(v) => onChange(patchParam(params, "systemPrompt", v))}
              multiline
              rows={3}
            />
          </Field>
          <Field label={t("model.label")} htmlFor="at-model" hint={t("model.hint")} name="model">
            <Input
              id="at-model"
              value={model}
              onChange={(e) => onChange(patchParam(params, "model", e.target.value))}
            />
          </Field>
          <Field
            label={t("allowedTools.label")}
            htmlFor="at-tools"
            hint={t("allowedTools.hint")}
            name="allowedTools"
          >
            <Input
              id="at-tools"
              value={allowedTools}
              onChange={(e) => {
                const list = e.target.value
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean)
                onChange(patchParam(params, "allowedTools", list.length > 0 ? list : undefined))
              }}
              placeholder={t("allowedTools.placeholder")}
            />
          </Field>
        </>
      ) : null}
      <FieldRow>
        <Field
          label={t("maxTurns.label")}
          htmlFor="at-max"
          hint={t("maxTurns.hint")}
          name="maxTurns"
        >
          <Input
            id="at-max"
            type="number"
            min={1}
            max={100}
            value={maxTurns}
            onChange={(e) => onChange(patchParam(params, "maxTurns", Number(e.target.value) || 1))}
          />
        </Field>
        <Field label={t("cwd.label")} htmlFor="at-cwd" hint={t("cwd.hint")} name="cwd">
          <Input
            id="at-cwd"
            value={cwd}
            onChange={(e) => onChange(patchParam(params, "cwd", e.target.value))}
          />
        </Field>
      </FieldRow>
      <Field
        label={t("toolsEnabled.label")}
        htmlFor="at-tools-on"
        hint={t("toolsEnabled.hint")}
        name="toolsEnabled"
      >
        <Switch
          id="at-tools-on"
          checked={toolsEnabled}
          onCheckedChange={(v) => onChange(patchParam(params, "toolsEnabled", v))}
        />
      </Field>
      {toolsEnabled ? (
        <Field
          label={t("requireTools.label")}
          htmlFor="at-require"
          hint={t("requireTools.hint")}
          name="requireTools"
        >
          <Switch
            id="at-require"
            checked={requireTools}
            onCheckedChange={(v) => onChange(patchParam(params, "requireTools", v))}
          />
        </Field>
      ) : null}
      <FieldRow>
        <Field
          label={t("temperature.label")}
          htmlFor="at-temp"
          hint={t("temperature.hint")}
          name="temperature"
        >
          <Input
            id="at-temp"
            type="number"
            min={0}
            max={2}
            step={0.1}
            value={temperature}
            placeholder={t("temperature.placeholder")}
            onChange={(e) => {
              const raw = e.target.value
              if (raw === "") {
                onChange(patchParam(params, "temperature", undefined))
                return
              }
              const parsed = Number(raw)
              if (Number.isNaN(parsed)) return
              onChange(patchParam(params, "temperature", Math.min(2, Math.max(0, parsed))))
            }}
          />
        </Field>
        <Field
          label={t("timeoutMs.label")}
          htmlFor="at-timeout"
          hint={t("timeoutMs.hint")}
          name="timeoutMs"
        >
          <DurationField
            id="at-timeout"
            value={timeoutMs}
            onChange={(ms) =>
              onChange(
                patchParam(
                  params,
                  "timeoutMs",
                  // Keep inside the schema's 1s..1h window.
                  Math.min(3_600_000, Math.max(1000, ms))
                )
              )
            }
          />
        </Field>
      </FieldRow>
      <PiiGateField id="at-pii" value={piiGate} params={params} onChange={onChange} t={t} />
      <TypedOutputFields params={params} onChange={onChange} idPrefix="at" />
    </FieldGroup>
  )
}

// ── action.character.create ───────────────────────────────────────────────
export function CharacterCreateConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.characterCreate")
  const name = readString(params, "name")
  const systemPrompt = readString(params, "systemPrompt")
  const description = readString(params, "description")
  const avatarColor = readString(params, "avatarColor")
  const avatarEmoji = readString(params, "avatarEmoji")
  const model = readString(params, "model")
  return (
    <FieldGroup>
      <Field label={t("name.label")} htmlFor="cc-name" name="name" required>
        <Input
          id="cc-name"
          value={name}
          onChange={(e) => onChange(patchParam(params, "name", e.target.value))}
          placeholder={t("name.placeholder")}
        />
      </Field>
      <Field
        label={t("systemPrompt.label")}
        htmlFor="cc-sys"
        hint={t("systemPrompt.hint")}
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
      <Field label={t("description.label")} htmlFor="cc-desc" name="description">
        <Textarea
          id="cc-desc"
          value={description}
          onChange={(e) => onChange(patchParam(params, "description", e.target.value))}
          rows={2}
        />
      </Field>
      <FieldRow columns={3}>
        <Field label={t("avatarColor.label")} htmlFor="cc-color" name="avatarColor">
          <Input
            id="cc-color"
            value={avatarColor}
            onChange={(e) => onChange(patchParam(params, "avatarColor", e.target.value))}
            placeholder={t("avatarColor.placeholder")}
          />
        </Field>
        <Field label={t("avatarEmoji.label")} htmlFor="cc-emoji" name="avatarEmoji">
          <Input
            id="cc-emoji"
            value={avatarEmoji}
            onChange={(e) => onChange(patchParam(params, "avatarEmoji", e.target.value))}
            placeholder={t("avatarEmoji.placeholder")}
          />
        </Field>
        <Field label={t("model.label")} htmlFor="cc-model" name="model">
          <Input
            id="cc-model"
            value={model}
            onChange={(e) => onChange(patchParam(params, "model", e.target.value))}
            placeholder={t("model.placeholder")}
          />
        </Field>
      </FieldRow>
    </FieldGroup>
  )
}

// ── action.character.update ───────────────────────────────────────────────
export function CharacterUpdateConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.characterUpdate")
  const characterId = readString(params, "characterId")
  const patchJson = readString(params, "patchJson")
  return (
    <FieldGroup>
      <Field label={t("characterId.label")} htmlFor="cu-char" name="characterId" required>
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
        label={t("patchJson.label")}
        htmlFor="cu-patch"
        hint={t("patchJson.hint")}
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
  const t = useTranslations("workflows.forms.teamCreate")
  const name = readString(params, "name")
  const description = readString(params, "description")
  const orchestration = readString(params, "orchestration", "round_robin")
  const supervisorCharacterId = readString(params, "supervisorCharacterId")
  const membersJson = readString(params, "membersJson", "[]")
  return (
    <FieldGroup>
      <Field label={t("name.label")} htmlFor="tc-name" name="name" required>
        <Input
          id="tc-name"
          value={name}
          onChange={(e) => onChange(patchParam(params, "name", e.target.value))}
        />
      </Field>
      <Field label={t("description.label")} htmlFor="tc-desc" name="description">
        <Textarea
          id="tc-desc"
          value={description}
          onChange={(e) => onChange(patchParam(params, "description", e.target.value))}
          rows={2}
        />
      </Field>
      <Field label={t("orchestration.label")} htmlFor="tc-orc" name="orchestration">
        <Select
          value={orchestration}
          onValueChange={(v) => onChange(patchParam(params, "orchestration", v))}
        >
          <SelectTrigger id="tc-orc">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="round_robin">{t("orchestration.options.round_robin")}</SelectItem>
            <SelectItem value="supervisor">{t("orchestration.options.supervisor")}</SelectItem>
            <SelectItem value="mention_round_robin">
              {t("orchestration.options.mention_round_robin")}
            </SelectItem>
          </SelectContent>
        </Select>
      </Field>
      {orchestration === "supervisor" ? (
        <Field label={t("supervisor.label")} htmlFor="tc-sup" name="supervisorCharacterId">
          <CharacterPicker
            id="tc-sup"
            value={supervisorCharacterId}
            onChange={(v) => onChange(patchParam(params, "supervisorCharacterId", v))}
          />
        </Field>
      ) : null}
      <Field
        label={t("members.label")}
        htmlFor="tc-members"
        hint={t("members.hint")}
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
  const t = useTranslations("workflows.forms.teamUpdate")
  const teamId = readString(params, "teamId")
  const patchJson = readString(params, "patchJson")
  return (
    <FieldGroup>
      <Field label={t("teamId.label")} htmlFor="tu-team" name="teamId" required>
        <TeamPicker
          id="tu-team"
          value={teamId}
          onChange={(v) => onChange(patchParam(params, "teamId", v))}
        />
      </Field>
      <Field
        label={t("patchJson.label")}
        htmlFor="tu-patch"
        hint={t("patchJson.hint")}
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

// ── action.team.task.dispatch ─────────────────────────────────────────────
// Synthesizer-emitted dispatch node. Mirrors the executor's input contract in
// `lib/workflow/nodes/built-ins.ts` (teamId/taskId/title/description + optional
// expectedOutput).
export function TeamTaskDispatchConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.teamTaskDispatch")
  const teamId = readString(params, "teamId")
  const taskId = readString(params, "taskId")
  const title = readString(params, "title")
  const description = readString(params, "description")
  const expectedOutput = readString(params, "expectedOutput")
  const assignedTo = readString(params, "assignedTo")
  const dependencies = Array.isArray(params.dependencies)
    ? (params.dependencies as string[]).join(", ")
    : ""
  // `access` / `taskKind` / `repositoryId` / `fileOwnership` are what
  // `synthesizeTeamWorkflow` stamps onto a task when an agent team is turned
  // into a workflow. They decide whether the teammate may write, which prompt
  // shape it gets, and which files it owns — so an author opening that
  // workflow has to be able to see and change them.
  const access = readString(params, "access", "write")
  const taskKind = readString(params, "taskKind", "code")
  const repositoryId = readString(params, "repositoryId")
  const fileOwnership = Array.isArray(params.fileOwnership)
    ? (params.fileOwnership as string[]).join(", ")
    : ""
  const patchList = (key: string, raw: string) => {
    const list = raw
      .split(",")
      .map((v) => v.trim())
      .filter(Boolean)
    onChange(patchParam(params, key, list.length > 0 ? list : undefined))
  }
  return (
    <FieldGroup>
      <Field label={t("teamId.label")} htmlFor="ttd-team" name="teamId" required>
        <TeamPicker
          id="ttd-team"
          value={teamId}
          onChange={(v) => onChange(patchParam(params, "teamId", v))}
        />
      </Field>
      <Field
        label={t("taskId.label")}
        htmlFor="ttd-task"
        hint={t("taskId.hint")}
        name="taskId"
        required
      >
        <Input
          id="ttd-task"
          value={taskId}
          onChange={(e) => onChange(patchParam(params, "taskId", e.target.value))}
          placeholder={t("taskId.placeholder")}
        />
      </Field>
      <Field label={t("title.label")} htmlFor="ttd-title" name="title" required>
        <Input
          id="ttd-title"
          value={title}
          onChange={(e) => onChange(patchParam(params, "title", e.target.value))}
          placeholder={t("title.placeholder")}
        />
      </Field>
      <Field label={t("description.label")} htmlFor="ttd-desc" name="description" required>
        <Textarea
          id="ttd-desc"
          rows={3}
          value={description}
          onChange={(e) => onChange(patchParam(params, "description", e.target.value))}
          placeholder={t("description.placeholder")}
        />
      </Field>
      <Field
        label={t("expectedOutput.label")}
        htmlFor="ttd-expected"
        hint={t("expectedOutput.hint")}
        name="expectedOutput"
      >
        <Textarea
          id="ttd-expected"
          rows={2}
          value={expectedOutput}
          onChange={(e) => onChange(patchParam(params, "expectedOutput", e.target.value))}
        />
      </Field>
      <FieldRow>
        <Field
          label={t("assignedTo.label")}
          htmlFor="ttd-assigned"
          hint={t("assignedTo.hint")}
          name="assignedTo"
        >
          <Input
            id="ttd-assigned"
            value={assignedTo}
            onChange={(e) => onChange(patchParam(params, "assignedTo", e.target.value))}
            placeholder={t("assignedTo.placeholder")}
          />
        </Field>
        <Field
          label={t("dependencies.label")}
          htmlFor="ttd-deps"
          hint={t("dependencies.hint")}
          name="dependencies"
        >
          <Input
            id="ttd-deps"
            value={dependencies}
            onChange={(e) => patchList("dependencies", e.target.value)}
            placeholder={t("dependencies.placeholder")}
          />
        </Field>
      </FieldRow>
      <FieldRow>
        <Field label={t("access.label")} htmlFor="ttd-access" hint={t("access.hint")} name="access">
          <Select value={access} onValueChange={(v) => onChange(patchParam(params, "access", v))}>
            <SelectTrigger id="ttd-access">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="read">{t("access.read")}</SelectItem>
              <SelectItem value="write">{t("access.write")}</SelectItem>
            </SelectContent>
          </Select>
        </Field>
        <Field
          label={t("taskKind.label")}
          htmlFor="ttd-kind"
          hint={t("taskKind.hint")}
          name="taskKind"
        >
          <Select
            value={taskKind}
            onValueChange={(v) => onChange(patchParam(params, "taskKind", v))}
          >
            <SelectTrigger id="ttd-kind">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="code">{t("taskKind.code")}</SelectItem>
              <SelectItem value="ui">{t("taskKind.ui")}</SelectItem>
              <SelectItem value="general">{t("taskKind.general")}</SelectItem>
            </SelectContent>
          </Select>
        </Field>
      </FieldRow>
      <Field
        label={t("repositoryId.label")}
        htmlFor="ttd-repo"
        hint={t("repositoryId.hint")}
        name="repositoryId"
      >
        <Input
          id="ttd-repo"
          value={repositoryId}
          onChange={(e) => onChange(patchParam(params, "repositoryId", e.target.value))}
        />
      </Field>
      <Field
        label={t("fileOwnership.label")}
        htmlFor="ttd-files"
        hint={t("fileOwnership.hint")}
        name="fileOwnership"
      >
        <Input
          id="ttd-files"
          value={fileOwnership}
          onChange={(e) => patchList("fileOwnership", e.target.value)}
          placeholder={t("fileOwnership.placeholder")}
        />
      </Field>
    </FieldGroup>
  )
}

export function PetInteractConfig({ params, onChange }: ConfigProps) {
  const t = useTranslations("workflows.forms.petInteract")
  const kind = readString(params, "kind", "fed")
  const itemId = readString(params, "itemId")
  return (
    <FieldGroup>
      <Field label={t("kind.label")} htmlFor="pet-interact-kind" name="kind" required>
        <Select value={kind} onValueChange={(v) => onChange(patchParam(params, "kind", v))}>
          <SelectTrigger id="pet-interact-kind">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PET_INTERACTION_KINDS.map((option) => (
              <SelectItem key={option} value={option}>
                {t(`kind.options.${option}` as never)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>
      <Field
        label={t("itemId.label")}
        htmlFor="pet-interact-item"
        hint={t("itemId.hint")}
        name="itemId"
      >
        <Input
          id="pet-interact-item"
          value={itemId}
          onChange={(e) => onChange(patchParam(params, "itemId", e.target.value))}
          placeholder={t("itemId.placeholder")}
        />
      </Field>
    </FieldGroup>
  )
}
