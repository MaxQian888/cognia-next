/**
 * Host hook dialects for plugin conversion.
 *
 * Cognia's `commandHooks` contract is the Claude Code `hooks.json` event map
 * (`Event → [{ matcher?, hooks: [handler] }]`, timeouts in seconds). Other
 * agent hosts ship hooks that look similar but differ in event names, entry
 * shape, handler types, timeout units and tool vocabulary. A dialect records
 * exactly what each host documents so conversion can translate the parts with
 * a 1:1 equivalent and report everything else as blocking — never rename a
 * key and call the behavior converted.
 *
 * Sources (researched 2026-10-02): Claude Code plugins reference (v2.1.283),
 * Codex `codex-rs/core-plugins` (rust-v0.160.0), Gemini CLI hooks reference
 * (v0.62.0), Cursor hooks/plugins reference, Factory Droid hooks reference,
 * Qoder CLI hooks, CodeBuddy plugins reference, Auggie hooks, OpenHands SDK
 * hooks (the legacy OpenPlugin layout).
 *
 * Exactness rules shared by every dialect:
 *
 * - An event converts only through an explicit entry in `events`.
 * - A handler type converts only when both the host and Cognia execute it.
 * - Hosts whose tool events use their own tool names (Gemini `run_shell_command`,
 *   Cursor `Shell`, Droid `Execute`, Auggie `launch-process`, OpenHands
 *   `terminal`) cannot carry a non-wildcard matcher across: the same regex
 *   selects different tools. Wildcard matchers convert with a warning because
 *   scripts that inspect `tool_name` still see the host's vocabulary.
 * - Hosts whose stdin payload or stdout decision schema is not Claude's get a
 *   warning: exit code 2 blocking is shared, JSON decisions are not.
 */

import type { HookEvent, HooksConfig } from "@/lib/claude/hooks"
import { HOOK_EVENTS } from "@/lib/claude/hooks/event-catalog"

export interface HookConversionIssue {
  capability: string
  path: string
  message: string
  blocking: boolean
}

/** The slice of a conversion report hook translation writes to. */
export interface HookIssueSink {
  warnings: HookConversionIssue[]
  blocking: HookConversionIssue[]
}

export type HookDialectId =
  | "claude-code"
  | "codex"
  | "gemini-cli"
  | "cursor"
  | "factory-droid"
  | "qoder"
  | "codebuddy"
  | "auggie"
  | "openhands"

export interface HookDialect {
  id: HookDialectId
  /** Host name used in report messages. */
  label: string
  /** Host event name → the canonical Cognia event it is exactly equivalent to. */
  events: Readonly<Record<string, HookEvent>>
  /**
   * `groups`: Claude shape, `{ matcher?, hooks: [handler] }` per entry.
   * `flat`: one handler per entry with the matcher inline (Cursor).
   */
  shape: "groups" | "flat"
  /** Handler types the host executes and Cognia can run verbatim. */
  handlerTypes: readonly string[]
  /** Events on which `prompt` handlers are honored (CodeBuddy restricts them). */
  promptEvents?: readonly HookEvent[]
  timeoutUnit: "seconds" | "milliseconds"
  /** Tool events report and match Claude tool names (Bash, Edit, …). */
  claudeToolNames: boolean
  /** Stdin payload fields and stdout JSON decisions follow Claude's contract. */
  claudeContract: boolean
  /** Extra group-level keys the host documents, with the only value that converts. */
  groupFlags?: Readonly<Record<string, unknown>>
  /** Handler keys that only label the hook in the host UI. */
  presentationFields?: readonly string[]
  /** Optional constraint the host puts on `command` (Auggie runs script files only). */
  commandRule?: { pattern: RegExp; message: string }
  /** Accepted top-level `version` value, when the host versions its hook file. */
  version?: number
}

const CLAUDE_HANDLERS = ["command", "http", "prompt", "agent", "mcp_tool"] as const

function identity(events: readonly HookEvent[]): Record<string, HookEvent> {
  return Object.fromEntries(events.map((event) => [event, event]))
}

export const HOOK_DIALECTS: Readonly<Record<HookDialectId, HookDialect>> = {
  "claude-code": {
    id: "claude-code",
    label: "Claude Code",
    events: identity(HOOK_EVENTS),
    shape: "groups",
    handlerTypes: CLAUDE_HANDLERS,
    timeoutUnit: "seconds",
    claudeToolNames: true,
    claudeContract: true,
  },
  codex: {
    id: "codex",
    label: "Codex",
    // `Interrupt` has no Cognia hook event and stays blocking.
    events: identity([
      "PreToolUse",
      "PermissionRequest",
      "PostToolUse",
      "PreCompact",
      "PostCompact",
      "SessionStart",
      "SessionEnd",
      "UserPromptSubmit",
      "SubagentStart",
      "SubagentStop",
      "Stop",
    ]),
    shape: "groups",
    // Codex parses `prompt` / `agent` handlers but skips them: converting one
    // would activate behavior that never ran in the source host.
    handlerTypes: ["command", "mcp_tool"],
    timeoutUnit: "seconds",
    claudeToolNames: true,
    claudeContract: true,
  },
  "gemini-cli": {
    id: "gemini-cli",
    label: "Gemini CLI",
    events: {
      BeforeTool: "PreToolUse",
      AfterTool: "PostToolUse",
      SessionStart: "SessionStart",
      SessionEnd: "SessionEnd",
      Notification: "Notification",
      PreCompress: "PreCompact",
    },
    shape: "groups",
    handlerTypes: ["command"],
    timeoutUnit: "milliseconds",
    claudeToolNames: false,
    claudeContract: false,
    // `sequential: true` serializes a group; Cognia runs a group's handlers
    // with Claude semantics, so only the default converts.
    groupFlags: { sequential: false },
    presentationFields: ["name", "description"],
  },
  cursor: {
    id: "cursor",
    label: "Cursor",
    events: {
      sessionStart: "SessionStart",
      sessionEnd: "SessionEnd",
      preToolUse: "PreToolUse",
      postToolUse: "PostToolUse",
      postToolUseFailure: "PostToolUseFailure",
      subagentStart: "SubagentStart",
      subagentStop: "SubagentStop",
      beforeSubmitPrompt: "UserPromptSubmit",
      preCompact: "PreCompact",
      stop: "Stop",
    },
    shape: "flat",
    handlerTypes: ["command"],
    timeoutUnit: "seconds",
    claudeToolNames: false,
    claudeContract: false,
    version: 1,
  },
  "factory-droid": {
    id: "factory-droid",
    label: "Factory Droid",
    events: identity([
      "PreToolUse",
      "PostToolUse",
      "Notification",
      "UserPromptSubmit",
      "Stop",
      "SubagentStop",
      "PreCompact",
      "SessionStart",
      "SessionEnd",
    ]),
    shape: "groups",
    handlerTypes: ["command"],
    timeoutUnit: "seconds",
    claudeToolNames: false,
    claudeContract: true,
  },
  qoder: {
    id: "qoder",
    label: "Qoder CLI",
    events: identity([
      "SessionStart",
      "SessionEnd",
      "UserPromptSubmit",
      "PreToolUse",
      "PostToolUse",
      "PostToolUseFailure",
      "PermissionRequest",
      "PermissionDenied",
      "Stop",
      "StopFailure",
      "SubagentStart",
      "SubagentStop",
      "PreCompact",
      "PostCompact",
      "Notification",
      "InstructionsLoaded",
      "ConfigChange",
      "CwdChanged",
      "FileChanged",
      "WorktreeCreate",
      "WorktreeRemove",
      "Elicitation",
      "ElicitationResult",
    ]),
    shape: "groups",
    handlerTypes: ["command", "http", "prompt", "agent"],
    timeoutUnit: "seconds",
    claudeToolNames: true,
    claudeContract: true,
  },
  codebuddy: {
    id: "codebuddy",
    label: "CodeBuddy",
    events: identity([
      "SessionStart",
      "UserPromptSubmit",
      "PreToolUse",
      "PermissionRequest",
      "PermissionDenied",
      "PostToolUse",
      "PostToolUseFailure",
      "Notification",
      "SubagentStart",
      "SubagentStop",
      "TaskCreated",
      "TaskCompleted",
      "Stop",
      "StopFailure",
      "TeammateIdle",
      "InstructionsLoaded",
      "ConfigChange",
      "CwdChanged",
      "FileChanged",
      "WorktreeCreate",
      "WorktreeRemove",
      "PreCompact",
      "PostCompact",
      "Elicitation",
      "ElicitationResult",
      "SessionEnd",
    ]),
    shape: "groups",
    handlerTypes: ["command", "prompt"],
    promptEvents: ["Stop", "UserPromptSubmit", "PreToolUse"],
    timeoutUnit: "seconds",
    claudeToolNames: true,
    claudeContract: true,
  },
  auggie: {
    id: "auggie",
    label: "Auggie",
    events: identity(["PreToolUse", "PostToolUse", "Stop", "SessionStart", "SessionEnd"]),
    shape: "groups",
    handlerTypes: ["command"],
    timeoutUnit: "milliseconds",
    claudeToolNames: false,
    claudeContract: false,
    commandRule: {
      pattern: /^\s*"?[^\s"]+\.(?:sh|ps1|cmd|bat)"?(?:\s|$)/i,
      message:
        "Auggie runs hook script files only (.sh, .ps1, .cmd, .bat); an inline shell command has no Auggie equivalent",
    },
  },
  openhands: {
    id: "openhands",
    label: "OpenHands",
    events: identity([
      "PreToolUse",
      "PostToolUse",
      "UserPromptSubmit",
      "Stop",
      "SessionStart",
      "SessionEnd",
    ]),
    shape: "groups",
    handlerTypes: ["command"],
    timeoutUnit: "seconds",
    claudeToolNames: false,
    claudeContract: false,
  },
}

const WILDCARD_MATCHERS = new Set(["", "*", ".*", "**"])

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function block(sink: HookIssueSink, path: string, message: string): void {
  sink.blocking.push({ capability: "commandHooks", path, message, blocking: true })
}

function warn(sink: HookIssueSink, path: string, message: string): void {
  if (sink.warnings.some((issue) => issue.path === path && issue.message === message)) return
  sink.warnings.push({ capability: "commandHooks", path, message, blocking: false })
}

function contractWarning(dialect: HookDialect): string | undefined {
  if (dialect.claudeContract && dialect.claudeToolNames) return undefined
  return dialect.claudeContract
    ? `${dialect.label} reports its own tool names in hook payloads; exit-code blocking is shared, but scripts that inspect tool_name/tool_input must be verified`
    : `${dialect.label} hook payload fields and JSON decision output differ from Claude's contract; exit code 2 blocking is shared, but scripts that parse stdin or print decisions must be verified`
}

function convertTimeout(
  value: unknown,
  from: HookDialect["timeoutUnit"],
  to: HookDialect["timeoutUnit"]
): unknown {
  if (typeof value !== "number" || from === to) return value
  return from === "milliseconds" ? value / 1000 : Math.round(value * 1000)
}

/**
 * Translate one host hook document into the canonical `{ hooks: EventMap }`
 * document `convertHookDocuments` validates. Unmappable entries are reported
 * on `sink` and left out of the result.
 */
export function hookDocumentToCanonical(args: {
  value: Record<string, unknown>
  path: string
  dialect: HookDialect
  sink: HookIssueSink
}): Record<string, unknown> {
  const { value, path, dialect, sink } = args
  if (dialect.id === "claude-code") return value
  const wrapped = isRecord(value.hooks)
  const eventMap = wrapped ? (value.hooks as Record<string, unknown>) : value
  if (wrapped) {
    for (const key of Object.keys(value)) {
      if (key === "hooks" || key === "description") continue
      if (key === "version" && dialect.version !== undefined && value.version === dialect.version)
        continue
      block(sink, path, `${dialect.label} hook file field "${key}" has no Cognia equivalent`)
    }
  }
  const canonical: Record<string, unknown[]> = {}
  let converted = 0
  for (const [hostEvent, entries] of Object.entries(eventMap)) {
    const event = dialect.events[hostEvent]
    if (!event) {
      block(
        sink,
        path,
        `${dialect.label} hook event "${hostEvent}" has no exact Cognia hook-runtime equivalent`
      )
      continue
    }
    if (!Array.isArray(entries)) {
      block(sink, path, `hook event "${hostEvent}" must map to an array`)
      continue
    }
    const groups: unknown[] = []
    for (const [index, entry] of entries.entries()) {
      if (!isRecord(entry)) {
        block(sink, path, `hook entry "${hostEvent}"[${index}] must be an object`)
        continue
      }
      const group =
        dialect.shape === "flat"
          ? (() => {
              const { matcher, ...handler } = entry
              return { ...(matcher !== undefined ? { matcher } : {}), hooks: [handler] }
            })()
          : { ...entry }
      for (const [flag, accepted] of Object.entries(dialect.groupFlags ?? {})) {
        if (!(flag in group)) continue
        if ((group as Record<string, unknown>)[flag] !== accepted) {
          block(
            sink,
            path,
            `${dialect.label} hook group "${hostEvent}"[${index}] sets ${flag}=${JSON.stringify((group as Record<string, unknown>)[flag])}, which Cognia cannot reproduce`
          )
        }
        delete (group as Record<string, unknown>)[flag]
      }
      const matcher = (group as Record<string, unknown>).matcher
      if (
        matcher !== undefined &&
        !dialect.claudeToolNames &&
        !(typeof matcher === "string" && WILDCARD_MATCHERS.has(matcher.trim()))
      ) {
        block(
          sink,
          path,
          `${dialect.label} matcher ${JSON.stringify(matcher)} on "${hostEvent}" selects the host's own tool or event vocabulary; it cannot be mapped to Cognia's`
        )
        continue
      }
      if (matcher !== undefined && !dialect.claudeToolNames) delete group.matcher
      const handlers = (group as Record<string, unknown>).hooks
      if (Array.isArray(handlers)) {
        ;(group as Record<string, unknown>).hooks = handlers.map((raw, handlerIndex) => {
          if (!isRecord(raw)) return raw
          const handler: Record<string, unknown> = { ...raw }
          if (handler.type === undefined && dialect.shape === "flat") handler.type = "command"
          const type = handler.type
          if (typeof type === "string" && !dialect.handlerTypes.includes(type)) {
            block(
              sink,
              path,
              `${dialect.label} hook handler "${hostEvent}"[${index}].hooks[${handlerIndex}] of type "${type}" is not executed by ${dialect.label} or has no exact Cognia equivalent`
            )
          }
          if (type === "prompt" && dialect.promptEvents && !dialect.promptEvents.includes(event)) {
            block(
              sink,
              path,
              `${dialect.label} only runs prompt hooks on ${dialect.promptEvents.join(", ")}`
            )
          }
          for (const field of dialect.presentationFields ?? []) {
            if (handler[field] === undefined) continue
            warn(
              sink,
              path,
              `${dialect.label} hook ${field} labels the hook in the host UI only and was not projected`
            )
            delete handler[field]
          }
          if (handler.timeout !== undefined)
            handler.timeout = convertTimeout(handler.timeout, dialect.timeoutUnit, "seconds")
          return handler
        })
      }
      groups.push(group)
    }
    if (groups.length) {
      canonical[event] = [...(canonical[event] ?? []), ...groups]
      converted += groups.length
    }
  }
  const message = contractWarning(dialect)
  if (message && converted > 0) warn(sink, path, message)
  return { hooks: canonical }
}

/**
 * Project validated canonical hooks into a host hook document. Returns
 * `undefined` when nothing could be projected; every omission is reported.
 */
export function canonicalHooksToDialect(args: {
  hooks: HooksConfig
  dialect: HookDialect
  sink: HookIssueSink
  path: string
}): Record<string, unknown> | undefined {
  const { hooks, dialect, sink, path } = args
  const reverse = new Map<string, string>()
  for (const [hostEvent, canonical] of Object.entries(dialect.events)) {
    if (!reverse.has(canonical)) reverse.set(canonical, hostEvent)
  }
  const output: Record<string, unknown[]> = {}
  for (const [event, groups] of Object.entries(hooks)) {
    if (!groups?.length) continue
    const hostEvent = reverse.get(event)
    if (!hostEvent) {
      block(
        sink,
        `commandHooks.${event}`,
        `${dialect.label} has no hook event equivalent to ${event}`
      )
      continue
    }
    const entries: unknown[] = []
    for (const [index, group] of groups.entries()) {
      const location = `commandHooks.${event}[${index}]`
      if (group.agents) {
        block(sink, location, `${dialect.label} cannot enforce Cognia agent selectors`)
        continue
      }
      const matcher = group.matcher
      const wildcard = matcher === undefined || WILDCARD_MATCHERS.has(matcher.trim())
      if (!wildcard && !dialect.claudeToolNames) {
        block(
          sink,
          location,
          `${dialect.label} matches ${JSON.stringify(matcher)} against its own tool vocabulary; the matcher cannot be carried across`
        )
        continue
      }
      const handlers: Record<string, unknown>[] = []
      for (const handler of group.hooks) {
        if (!dialect.handlerTypes.includes(handler.type)) {
          block(sink, location, `${dialect.label} does not execute "${handler.type}" hook handlers`)
          continue
        }
        if (
          handler.type === "prompt" &&
          dialect.promptEvents &&
          !dialect.promptEvents.includes(event as HookEvent)
        ) {
          block(
            sink,
            location,
            `${dialect.label} only runs prompt hooks on ${dialect.promptEvents.join(", ")}`
          )
          continue
        }
        if ("policyClass" in handler && handler.policyClass === "managed") {
          block(sink, location, "Managed fail-closed hook policies require the Cognia host")
          continue
        }
        if (
          handler.type === "command" &&
          dialect.commandRule &&
          !dialect.commandRule.pattern.test(handler.command)
        ) {
          block(sink, location, dialect.commandRule.message)
          continue
        }
        const projected: Record<string, unknown> = { ...handler }
        delete projected.policyClass
        if (projected.timeout !== undefined)
          projected.timeout = convertTimeout(projected.timeout, "seconds", dialect.timeoutUnit)
        handlers.push(projected)
      }
      if (!handlers.length) continue
      if (dialect.shape === "flat") {
        for (const handler of handlers) {
          const { type, ...rest } = handler
          entries.push({
            ...(type === "command" ? {} : { type }),
            ...rest,
            ...(matcher !== undefined && !wildcard ? { matcher } : {}),
          })
        }
      } else {
        entries.push({
          ...(matcher !== undefined && (dialect.claudeToolNames || !wildcard) ? { matcher } : {}),
          hooks: handlers,
        })
      }
    }
    if (entries.length) output[hostEvent] = entries
  }
  if (!Object.keys(output).length) return undefined
  const message = contractWarning(dialect)
  if (message) warn(sink, path, message)
  return dialect.version !== undefined
    ? { version: dialect.version, hooks: output }
    : { hooks: output }
}
