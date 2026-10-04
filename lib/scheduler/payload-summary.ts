/**
 * What an app-table task actually runs, as facts the detail pane can render.
 *
 * The detail showed when a task fires, how it is bounded and what it did, but
 * not what it does: an agent task's prompt, a command task's command line, a
 * workflow task's workflow. The only way to read them was to open the edit
 * sheet, which is a form, not a description, and on a remote host or for a
 * type the form does not edit, not even that.
 *
 * This module is the pure half. It reads a payload the way the executors do
 * (including the legacy `message` / `agentTask` prompt keys the chat executor
 * still lifts) and returns labelled facts; references to other records
 * (characters, workflows, plans, teams, external agents, sessions) are
 * returned as ids for the component to resolve, so this stays testable
 * without a database.
 *
 * Every type keeps its raw payload in `raw`. A type with no structured reading
 * here (a connector housekeeping row, a Twin ingest) still shows exactly what
 * is stored rather than nothing.
 */

import type { ScheduledTask, ScheduledTaskType } from "@/types/scheduler"

/** A record a payload names by id; the detail resolves it to a display name. */
export type PayloadReferenceKind =
  "character" | "skill" | "workflow" | "plan" | "team" | "externalAgent" | "session"

export type PayloadFactValue =
  | { kind: "text"; text: string }
  /** A fixed value with its own i18n key under `scheduler` (e.g. "No mode"). */
  | { kind: "label"; key: string }
  /** Prose the user wrote (a prompt, an objective): kept whole, line breaks intact. */
  | { kind: "multiline"; text: string }
  /** An identifier, a path or a command: monospace, never reflowed. */
  | { kind: "mono"; text: string }
  | { kind: "boolean"; value: boolean }
  | { kind: "duration"; ms: number }
  /** An instant, formatted by the component in the user's locale. */
  | { kind: "date"; at: number }
  | { kind: "count"; value: number }
  | { kind: "list"; items: string[]; mono?: boolean }
  /** Structured data a person may need to read exactly (workflow inputs, IM segments). */
  | { kind: "json"; value: unknown }
  | { kind: "reference"; ref: PayloadReferenceKind; id: string }

export interface PayloadFact {
  /** Stable per fact, for keys and tests. */
  id: string
  /**
   * An i18n key under the `scheduler` namespace. Reuses the form's own field
   * labels (`payload.*`) wherever the form has one, so a fact reads the same
   * as the field that set it.
   */
  label: string
  value: PayloadFactValue
}

export interface PayloadSummary {
  taskType: ScheduledTaskType
  facts: PayloadFact[]
  /** The stored payload, for the raw view. `undefined` when the task has none. */
  raw: Record<string, unknown> | undefined
}

type Payload = Record<string, unknown>

function asRecord(value: unknown): Payload | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Payload)
    : undefined
}

function str(payload: Payload, key: string): string | undefined {
  const value = payload[key]
  return typeof value === "string" && value.trim() !== "" ? value : undefined
}

function num(payload: Payload, key: string): number | undefined {
  const value = payload[key]
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function bool(payload: Payload, key: string): boolean | undefined {
  const value = payload[key]
  return typeof value === "boolean" ? value : undefined
}

function strings(payload: Payload, key: string): string[] | undefined {
  const value = payload[key]
  if (!Array.isArray(value)) return undefined
  const items = value.filter((item): item is string => typeof item === "string" && item !== "")
  return items.length > 0 ? items : undefined
}

/**
 * Collects facts, dropping the ones whose value is absent. A fact the task
 * never set is not a fact about the task; "Model: —" for every chat task that
 * follows its character's model would be noise that reads as misconfiguration.
 */
class FactBuilder {
  readonly facts: PayloadFact[] = []

  text(id: string, label: string, text: string | undefined): this {
    if (text !== undefined) this.facts.push({ id, label, value: { kind: "text", text } })
    return this
  }

  multiline(id: string, label: string, text: string | undefined): this {
    if (text !== undefined) this.facts.push({ id, label, value: { kind: "multiline", text } })
    return this
  }

  mono(id: string, label: string, text: string | undefined): this {
    if (text !== undefined) this.facts.push({ id, label, value: { kind: "mono", text } })
    return this
  }

  boolean(id: string, label: string, value: boolean | undefined): this {
    if (value !== undefined) this.facts.push({ id, label, value: { kind: "boolean", value } })
    return this
  }

  duration(id: string, label: string, ms: number | undefined): this {
    if (ms !== undefined && ms > 0) this.facts.push({ id, label, value: { kind: "duration", ms } })
    return this
  }

  /** Accepts the ISO strings and epoch numbers payloads store; anything unparsable is dropped. */
  date(id: string, label: string, value: unknown): this {
    if (typeof value !== "string" && typeof value !== "number") return this
    const at = new Date(value).getTime()
    if (Number.isFinite(at)) this.facts.push({ id, label, value: { kind: "date", at } })
    return this
  }

  count(id: string, label: string, value: number | undefined): this {
    if (value !== undefined) this.facts.push({ id, label, value: { kind: "count", value } })
    return this
  }

  list(id: string, label: string, items: string[] | undefined, mono = false): this {
    if (items !== undefined) this.facts.push({ id, label, value: { kind: "list", items, mono } })
    return this
  }

  json(id: string, label: string, value: unknown): this {
    if (value !== undefined && value !== null && value !== "") {
      this.facts.push({ id, label, value: { kind: "json", value } })
    }
    return this
  }

  reference(id: string, label: string, ref: PayloadReferenceKind, refId: string | undefined): this {
    if (refId !== undefined) {
      this.facts.push({ id, label, value: { kind: "reference", ref, id: refId } })
    }
    return this
  }
}

/**
 * The prompt a chat-like executor will send. `message` and `agentTask` are
 * the keys rows written before the payload was typed used; the executor still
 * lifts them, so the detail must too or those rows read as prompt-less.
 */
export function chatLikePrompt(payload: Payload): string | undefined {
  return str(payload, "prompt") ?? str(payload, "message") ?? str(payload, "agentTask")
}

function chatLikeFacts(builder: FactBuilder, payload: Payload): void {
  builder
    .multiline("prompt", "payload.prompt", chatLikePrompt(payload))
    .reference("character", "payload.character", "character", str(payload, "characterId"))
    .reference("skill", "payload.skill", "skill", str(payload, "skillId"))
    .reference("team", "payload.team", "team", str(payload, "teamId"))
    .reference("session", "payloadSummary.session", "session", str(payload, "sessionId"))
    .text("sessionTitle", "payload.sessionTitle", str(payload, "sessionTitle"))
    .mono("model", "payload.model", str(payload, "model"))

  // `agentModeId: null` is a deliberate opt-out, not an absent value.
  if (payload.agentModeId === null) {
    builder.facts.push({
      id: "agentMode",
      label: "payload.agentMode",
      value: { kind: "label", key: "payload.modeNone" },
    })
  } else {
    builder.mono("agentMode", "payload.agentMode", str(payload, "agentModeId"))
  }

  builder
    .mono("permissionMode", "payload.permissionMode", str(payload, "permissionMode"))
    .mono("effort", "payload.effort", str(payload, "effort"))
    .count("maxTurns", "payload.maxTurns", num(payload, "maxTurns"))
    .list("allowedTools", "payloadSummary.allowedTools", strings(payload, "allowedTools"), true)
    .list(
      "disallowedTools",
      "payloadSummary.disallowedTools",
      strings(payload, "disallowedTools"),
      true
    )

  // An empty array is "no MCP servers at all", which is a choice worth showing.
  if (Array.isArray(payload.mcpServerIds)) {
    const ids = strings(payload, "mcpServerIds") ?? []
    builder.facts.push({
      id: "mcpServers",
      label: "payload.mcp.heading",
      value:
        ids.length > 0 ? { kind: "list", items: ids, mono: true } : { kind: "count", value: 0 },
    })
  }

  builder
    .list(
      "additionalDirectories",
      "payload.additionalDirectories.heading",
      strings(payload, "additionalDirectories"),
      true
    )
    .list("disabledSkills", "payloadSummary.disabledSkills", strings(payload, "disabledSkillIds"))
    .multiline(
      "appendSystemPrompt",
      "payload.appendSystemPromptHeading",
      str(payload, "appendSystemPrompt")
    )
}

/** Read one task's payload into labelled facts. */
export function summarizeTaskPayload(
  task: Pick<ScheduledTask, "type" | "payload">
): PayloadSummary {
  const raw = asRecord(task.payload)
  const payload: Payload = raw ?? {}
  const builder = new FactBuilder()

  switch (task.type) {
    case "chat":
    case "agent":
    case "skill":
    case "ai-generation":
      chatLikeFacts(builder, payload)
      break

    case "external-agent":
      builder
        .multiline("prompt", "payload.prompt", str(payload, "prompt"))
        .reference(
          "agent",
          "payload.externalAgent.agentId",
          "externalAgent",
          str(payload, "agentId")
        )
        .mono("permissionMode", "payload.permissionMode", str(payload, "permissionMode"))
        .mono("cwd", "payload.externalAgent.cwd", str(payload, "cwd"))
        .duration("timeout", "payloadSummary.timeout", num(payload, "timeoutMs"))
      break

    case "agent-team":
      builder
        .reference("team", "payload.agentTeam.teamId", "team", str(payload, "teamId"))
        .boolean("ultracode", "payload.agentTeam.ultracode", bool(payload, "ultracode"))
      break

    case "goal": {
      const config = asRecord(payload.config) ?? {}
      builder
        .multiline("objective", "payload.goal.objective", str(payload, "objective"))
        .reference("character", "payload.character", "character", str(payload, "characterId"))
        .reference("session", "payloadSummary.session", "session", str(payload, "sessionId"))
        .text("sessionTitle", "payload.sessionTitle", str(payload, "sessionTitle"))
        .count("maxTurns", "payload.goal.maxTurns", num(config, "maxTurns"))
        .count("maxTokens", "payload.goal.maxTokens", num(config, "maxTokens"))
        .duration("timeout", "payloadSummary.timeout", num(config, "timeoutMs"))
      break
    }

    case "plan":
      builder
        .reference("plan", "payload.plan.planId", "plan", str(payload, "planId"))
        .boolean(
          "replanOnFailure",
          "payload.plan.replanOnFailure",
          bool(payload, "replanOnFailure")
        )
      break

    case "workflow":
      builder
        .reference(
          "workflow",
          "payload.workflow.workflowId",
          "workflow",
          str(payload, "workflowId")
        )
        .mono("environment", "payload.workflow.environment", str(payload, "environment"))
        .mono("triggerId", "payload.workflow.triggerId", str(payload, "triggerId"))
        .json("inputs", "payload.workflow.inputs", payload.inputs)
        .mono("idempotencyKey", "payload.workflow.idempotencyKey", str(payload, "idempotencyKey"))
      break

    case "im-push": {
      builder
        .mono("conversation", "payload.imPush.conversationKey", str(payload, "conversationKey"))
        .multiline("text", "payload.imPush.text", str(payload, "text"))
      if (Array.isArray(payload.segments) && payload.segments.length > 0) {
        builder.json("segments", "payload.imPush.segments", payload.segments)
      }
      builder.mono(
        "idempotencyKey",
        "payload.imPush.idempotencyKey",
        str(payload, "idempotencyKey")
      )
      break
    }

    case "background-command":
      builder
        .text("label", "payload.backgroundCommand.label", str(payload, "label"))
        .mono("command", "payload.backgroundCommand.command", str(payload, "command"))
        .mono("cwd", "payload.backgroundCommand.cwd", str(payload, "cwd"))
        .duration("maxRuntime", "payloadSummary.maxRuntime", num(payload, "maxRuntimeMs"))
      break

    case "script":
      builder
        .mono("language", "scriptEditor.language", str(payload, "language"))
        .mono("code", "scriptEditor.code", str(payload, "code"))
        .mono(
          "cwd",
          "scriptEditor.workingDirectory",
          str(payload, "working_dir") ?? str(payload, "cwd")
        )
        .list("args", "scriptEditor.args", strings(payload, "args"), true)
        .duration(
          "timeout",
          "payloadSummary.timeout",
          num(payload, "timeout_secs") !== undefined
            ? (num(payload, "timeout_secs") as number) * 1000
            : undefined
        )
        .boolean("sandbox", "scriptEditor.sandbox", bool(payload, "use_sandbox"))
      break

    case "monitor":
      builder
        .text("label", "payload.backgroundCommand.label", str(payload, "label"))
        .json("condition", "payloadSummary.condition", payload.condition)
        .date("expiresAt", "expiresAt", payload.expiresAt)
      break

    case "test":
      builder
        .json("echo", "payloadSummary.echo", payload.echo)
        .duration("delay", "payloadSummary.delay", num(payload, "delayMs"))
        .text("failWith", "payloadSummary.failWith", str(payload, "failWith"))
      break

    case "plugin":
      builder
        .mono("plugin", "plugin", str(payload, "pluginId"))
        .mono("handler", "handler", str(payload, "handler"))
        .json("args", "payloadSummary.handlerArgs", payload.args)
      break

    default:
      // No structured reading for this type; the raw view below carries it.
      break
  }

  return { taskType: task.type, facts: builder.facts, raw }
}
