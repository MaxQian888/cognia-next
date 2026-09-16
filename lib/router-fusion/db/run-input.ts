/**
 * A Run API run's input, as it is stored (ADR-0188 B2/B3).
 *
 * `POST /v1/runs` answers 202 and the request is gone. Everything a worker
 * needs to execute the run later — after a reload, on another window, after a
 * crash — is therefore stored with the run as one encrypted artifact: the
 * messages, and the request's own options that change how the run is judged
 * (whether a degraded result is acceptable, the structured output it asked
 * for).
 *
 * B2 stored the bare message array; that shape still reads, with the options
 * a B2 request could not have set.
 */

import type { Message } from "@cognia/router-fusion"

export interface StoredRunInput {
  messages: Message[]
  /** The request accepts an explicitly degraded result (spec `allow_degraded`). */
  allowDegraded: boolean
  /** The structured answer a chat-compat caller asked for (`response_format.json_schema`). */
  jsonSchema: Record<string, unknown> | null
}

const ROLES = new Set(["system", "user", "assistant"])

function isMessage(value: unknown): value is Message {
  if (typeof value !== "object" || value === null) return false
  const candidate = value as { role?: unknown; content?: unknown }
  return (
    typeof candidate.content === "string" &&
    typeof candidate.role === "string" &&
    ROLES.has(candidate.role)
  )
}

export function encodeRunInput(input: StoredRunInput): string {
  return JSON.stringify({ version: 2, ...input })
}

/** The stored input, or null when there is nothing a run could be sent with. */
export function decodeRunInput(content: string | null | undefined): StoredRunInput | null {
  if (!content) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return null
  }
  if (Array.isArray(parsed)) {
    const messages = parsed.filter(isMessage)
    return messages.length > 0 ? { messages, allowDegraded: false, jsonSchema: null } : null
  }
  if (typeof parsed !== "object" || parsed === null) return null
  const record = parsed as { messages?: unknown; allowDegraded?: unknown; jsonSchema?: unknown }
  const messages = Array.isArray(record.messages) ? record.messages.filter(isMessage) : []
  if (messages.length === 0) return null
  const schema = record.jsonSchema
  return {
    messages,
    allowDegraded: record.allowDegraded === true,
    jsonSchema:
      typeof schema === "object" && schema !== null && !Array.isArray(schema)
        ? (schema as Record<string, unknown>)
        : null,
  }
}
