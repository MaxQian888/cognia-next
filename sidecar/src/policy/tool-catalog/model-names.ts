// Model-facing tool names for the AI SDK dispatch path.
//
// Every wire protocol the AI SDK path speaks (OpenAI-compatible, Bedrock,
// Gemini, Anthropic) validates function names against `^[a-zA-Z0-9_-]{1,64}$`.
// Cognia tool names are looser: a plugin may register `ocr.extract`, and an MCP
// server may expose `docs/search`. Sending such a name makes the provider
// reject the whole request ("Invalid 'tools[3].function.name'"), so the turn
// dies before the model sees anything. The renderer, the permission rules and
// the plugin round-trip all key on the ORIGINAL name, so the fix is a
// reversible rename at the boundary: the model sees `ocr_extract`, everything
// on our side keeps seeing `ocr.extract`.

import { createHash } from "node:crypto"

/** What providers accept as a function/tool name. */
export const MODEL_TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/
const MAX_LENGTH = 64
const HASH_LENGTH = 7

/** Whether a name can be sent to a provider unchanged. */
export function isModelSafeToolName(name: unknown): name is string {
  return typeof name === "string" && MODEL_TOOL_NAME_PATTERN.test(name)
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, HASH_LENGTH)
}

/**
 * The provider-safe form of one tool name. Illegal characters become `_`, an
 * over-long name keeps its head and gains a short hash of the whole so two
 * long names that only differ in their tails stay distinct, and an empty
 * result is named after its hash so nothing collapses to a bare `_`.
 */
export function sanitizeModelToolName(name: unknown): string {
  const raw = String(name ?? "")
  let safe = raw.replace(/[^a-zA-Z0-9_-]+/g, "_")
  if (safe.replace(/_/g, "") === "") safe = `tool_${shortHash(raw)}`
  if (safe.length > MAX_LENGTH) {
    const hash = shortHash(raw)
    safe = `${safe.slice(0, MAX_LENGTH - HASH_LENGTH - 1)}_${hash}`
  }
  return safe
}

/**
 * Rename every tool in the map that a provider would reject. Returns the new
 * map (same insertion order, so a sorted input stays sorted for prompt-cache
 * prefix stability) plus the alias table `modelName → originalName`, which
 * only holds the names that actually changed. A sanitized name that collides
 * with an existing key or another rename gets a numeric suffix, so the model
 * always has one distinct name per tool.
 */
export function sanitizeToolMap<T>(tools: Record<string, T> | null | undefined): {
  tools: Record<string, T>
  aliases: Map<string, string>
} {
  const aliases = new Map<string, string>()
  const source: Record<string, T> = tools ?? {}
  const originals = Object.keys(source)
  const safeSet = new Set<string>(originals.filter(isModelSafeToolName))
  const out: Record<string, T> = {}
  for (const name of originals) {
    // `originals` are the map's own keys, so every lookup below is present.
    const tool = source[name] as T
    if (isModelSafeToolName(name)) {
      out[name] = tool
      continue
    }
    let candidate = sanitizeModelToolName(name)
    if (safeSet.has(candidate)) {
      const stem = candidate.slice(0, MAX_LENGTH - 3)
      for (let n = 2; safeSet.has(candidate); n += 1) candidate = `${stem}_${n}`
    }
    safeSet.add(candidate)
    aliases.set(candidate, name)
    out[candidate] = tool
  }
  return { tools: out, aliases }
}

/**
 * The original name for a model-facing one (identity when nothing was renamed).
 */
export function restoreToolName(
  aliases: ReadonlyMap<string, string> | undefined | null,
  name: string
): string {
  return (aliases && aliases.get(name)) ?? name
}

/**
 * The model-facing name for an original one, for callers that address tools
 * by their cognia name (ToolSearch `select:`, allow lists).
 */
export function modelToolName(
  aliases: ReadonlyMap<string, string> | undefined | null,
  name: string
): string {
  if (!aliases) return name
  for (const [safe, original] of aliases) if (original === name) return safe
  return name
}
