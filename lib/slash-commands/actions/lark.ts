/**
 * `/lark` slash command handler (ADR-0026).
 *
 * Surface:
 *   /lark agenda                  → lark.calendar.agenda_today
 *   /lark events <calendarId>     → lark.calendar.list_events
 *   /lark docs search <query>     → lark.doc.search
 *   /lark tasks                   → lark.task.list_my_tasks
 *   /lark wiki <query>            → lark.wiki.search_nodes
 *   /lark base search <query>     → lark.base.search
 *
 * The command routes through `runBuiltInSkill` so all gating (PII, audit,
 * allowedBuiltInSkillIds, HITL) fires identically to assistant-driven
 * invocations. Returns a Markdown system message containing the result.
 */

import { runBuiltInSkill } from "@/lib/skills/built-in/dispatcher"
import type { BuiltInSkillResult } from "@/lib/skills/built-in/types"

export interface SlashLarkInput {
  /** Raw argv after the `/lark ` prefix. */
  argv: string
  /** ChatSession id — threaded into the skill context. */
  sessionId: string
}

export interface SlashLarkResult {
  /** Markdown to push into the chat as a system message. */
  system: string
  errorCode?: string
}

interface ParsedCommand {
  skillId: string
  args: Record<string, unknown>
}

/**
 * Parse the argv into a (skillId, args) pair. Throws when the surface
 * doesn't recognise the verb — the caller surfaces the error as a
 * usage-hint system message.
 */
export function parseLarkArgs(argv: string): ParsedCommand {
  const tokens = tokenize(argv)
  if (tokens.length === 0) {
    throw new Error("Missing argument. Usage: /lark <agenda|events|docs|tasks|wiki|base> [args]")
  }
  const verb = tokens[0]!.toLowerCase()
  const rest = tokens.slice(1)
  switch (verb) {
    case "agenda":
      return { skillId: "lark.calendar.agenda_today", args: {} }
    case "events": {
      if (rest.length === 0) {
        throw new Error("Usage: /lark events <calendarId> [--start <iso> --end <iso>]")
      }
      const [calendarId, ...flagTokens] = rest
      const flags = parseFlags(flagTokens)
      return {
        skillId: "lark.calendar.list_events",
        args: { calendarId, ...flags },
      }
    }
    case "docs": {
      const sub = rest[0]?.toLowerCase()
      if (sub === "search") {
        const query = rest.slice(1).join(" ").trim()
        if (!query) throw new Error("Usage: /lark docs search <query>")
        return { skillId: "lark.doc.search", args: { query } }
      }
      throw new Error("Usage: /lark docs search <query>")
    }
    case "tasks":
      return { skillId: "lark.task.list_my_tasks", args: {} }
    case "wiki": {
      const query = rest.join(" ").trim()
      if (!query) throw new Error("Usage: /lark wiki <query>")
      return { skillId: "lark.wiki.search_nodes", args: { query } }
    }
    case "base": {
      const sub = rest[0]?.toLowerCase()
      if (sub === "search") {
        const query = rest.slice(1).join(" ").trim()
        if (!query) throw new Error("Usage: /lark base search <query>")
        return { skillId: "lark.base.search", args: { query } }
      }
      throw new Error("Usage: /lark base search <query>")
    }
    default:
      throw new Error(`Unknown /lark verb: "${verb}"`)
  }
}

/**
 * Execute a `/lark` invocation. Always returns a structured result;
 * never throws on a failed skill call — the error is surfaced via the
 * Markdown system message.
 */
export async function dispatchLarkSubcommand(input: SlashLarkInput): Promise<SlashLarkResult> {
  let parsed: ParsedCommand
  try {
    parsed = parseLarkArgs(input.argv)
  } catch (err) {
    return { system: errorBlock(err), errorCode: "parse_error" }
  }
  // Ensure the family barrel is loaded — `index` is a no-op import once
  // the registry is populated, so subsequent calls are zero-cost.
  await import("@/lib/skills/built-in")
  const result = await runBuiltInSkill(parsed.skillId, parsed.args, {
    sessionId: input.sessionId,
  })
  return { system: formatResult(parsed.skillId, result), errorCode: errCode(result) }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tokenize(argv: string): string[] {
  return argv
    .trim()
    .split(/\s+/)
    .filter((s) => s.length > 0)
}

function parseFlags(tokens: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i]
    if (!t.startsWith("--")) continue
    const key = camelCase(t.slice(2))
    const next = tokens[i + 1]
    if (next && !next.startsWith("--")) {
      out[key] = next
      i += 1
    } else {
      out[key] = "true"
    }
  }
  return out
}

function camelCase(s: string): string {
  return s.replace(/-([a-z])/g, (_, c) => c.toUpperCase())
}

function errCode(result: BuiltInSkillResult): string | undefined {
  if (result.status === "ok") return undefined
  if (result.status === "denied") return result.reason
  if (result.status === "pending_hitl") return "pending_hitl"
  return "error"
}

function formatResult(skillId: string, result: BuiltInSkillResult): string {
  const header = `**/lark** → \`${skillId}\``
  switch (result.status) {
    case "ok":
      return `${header}\n\n\`\`\`json\n${safeStringify(result.data)}\n\`\`\``
    case "pending_hitl":
      return `${header}\n\n_Awaiting confirmation in IM channel (surface ${result.surfaceId})._`
    case "denied":
      return `${header}\n\n⛔ Denied — **${result.reason}**. ${result.message}`
    case "error":
      return `${header}\n\n⚠️ Failed: ${result.message}`
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function errorBlock(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  return `**/lark** parse error\n\n${message}`
}
