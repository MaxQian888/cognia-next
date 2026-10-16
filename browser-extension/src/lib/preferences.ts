/**
 * The person's extension preferences and saved prompts (ADR-0228 §4, §7, §8).
 *
 * Both live in `chrome.storage.local` and both are the person's own settings,
 * never page content. Each is parsed defensively on read: storage is written
 * by older builds too, and a malformed value must fall back to the default
 * rather than break the worker that reads it on every wake-up.
 */

export interface ExtensionPreferences {
  /** System notifications for finished, failed and waiting tasks (opt-in). */
  notifications: boolean
  /** Agents may act in this browser; keeps the device socket open. */
  agentMode: boolean
  /** Hosts the panel refuses to capture, e.g. a bank. Lower-case. */
  blockedHosts: string[]
}

export const DEFAULT_PREFERENCES: ExtensionPreferences = Object.freeze({
  notifications: false,
  agentMode: false,
  blockedHosts: [],
}) as ExtensionPreferences

export const MAX_BLOCKED_HOSTS = 200

/** A host as typed — "Bank.example.com", "https://bank.example.com/x" — normalized, or null. */
export function normalizeHost(input: string): string | null {
  const trimmed = input.trim().toLowerCase()
  if (!trimmed) return null
  let host = trimmed
  try {
    host = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`).hostname
  } catch {
    return null
  }
  host = host.replace(/^\*\./, "").replace(/\.$/, "")
  const valid = host === "localhost" || (/^[a-z0-9.-]+$/.test(host) && host.includes("."))
  return valid ? host : null
}

export function parsePreferences(value: unknown): ExtensionPreferences {
  if (!value || typeof value !== "object") return { ...DEFAULT_PREFERENCES, blockedHosts: [] }
  const record = value as Record<string, unknown>
  const blockedHosts = Array.isArray(record.blockedHosts)
    ? [
        ...new Set(
          record.blockedHosts
            .filter((entry): entry is string => typeof entry === "string")
            .map(normalizeHost)
            .filter((entry): entry is string => entry !== null)
        ),
      ].slice(0, MAX_BLOCKED_HOSTS)
    : []
  return {
    notifications: record.notifications === true,
    agentMode: record.agentMode === true,
    blockedHosts,
  }
}

/** Whether `url`'s host, or a parent domain of it, is on the list. */
export function isBlockedUrl(url: string, blockedHosts: readonly string[]): boolean {
  let host: string
  try {
    host = new URL(url).hostname.toLowerCase()
  } catch {
    return false
  }
  return blockedHosts.some((blocked) => host === blocked || host.endsWith(`.${blocked}`))
}

export interface SavedPrompt {
  id: string
  title: string
  instruction: string
}

export const MAX_SAVED_PROMPTS = 50
export const MAX_PROMPT_TITLE = 80
/** The Host's own template-instruction ceiling (8 KiB of UTF-8). */
export const MAX_PROMPT_BYTES = 8 * 1024

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).byteLength
}

export function parseSavedPrompts(value: unknown): SavedPrompt[] {
  if (!Array.isArray(value)) return []
  const seen = new Set<string>()
  const prompts: SavedPrompt[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue
    const record = entry as Record<string, unknown>
    if (typeof record.id !== "string" || !record.id || seen.has(record.id)) continue
    if (typeof record.instruction !== "string" || !record.instruction.trim()) continue
    if (utf8Length(record.instruction) > MAX_PROMPT_BYTES) continue
    const title =
      typeof record.title === "string" && record.title.trim()
        ? record.title.trim()
        : record.instruction.trim()
    seen.add(record.id)
    prompts.push({
      id: record.id,
      title: title.slice(0, MAX_PROMPT_TITLE),
      instruction: record.instruction,
    })
    if (prompts.length === MAX_SAVED_PROMPTS) break
  }
  return prompts
}

export type SavePromptOutcome =
  { ok: true; prompts: SavedPrompt[] } | { ok: false; reason: "empty" | "too_long" | "full" }

/** Add or replace (by id) a saved prompt. */
export function upsertSavedPrompt(
  prompts: readonly SavedPrompt[],
  prompt: SavedPrompt
): SavePromptOutcome {
  const instruction = prompt.instruction
  if (!instruction.trim()) return { ok: false, reason: "empty" }
  if (utf8Length(instruction) > MAX_PROMPT_BYTES) return { ok: false, reason: "too_long" }
  const title = (prompt.title.trim() || instruction.trim()).slice(0, MAX_PROMPT_TITLE)
  const existing = prompts.findIndex((entry) => entry.id === prompt.id)
  if (existing >= 0) {
    const next = [...prompts]
    next[existing] = { id: prompt.id, title, instruction }
    return { ok: true, prompts: next }
  }
  if (prompts.length >= MAX_SAVED_PROMPTS) return { ok: false, reason: "full" }
  return { ok: true, prompts: [...prompts, { id: prompt.id, title, instruction }] }
}
