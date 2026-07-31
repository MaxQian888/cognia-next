/**
 * Turn a concrete MCP server config into a reusable preset by replacing
 * every user-specific value with a declared, user-filled field.
 *
 * The rule is absolute: **no value from the source config is ever written
 * into the generated `plugin.json`** — not as a value, not as a default,
 * not as a placeholder. A real `~/.cursor/mcp.json` routinely holds live
 * tokens (`GITHUB_TOKEN`, `OPENAI_API_KEY`) and machine-specific absolute
 * paths, and the generated project is meant to be committed and shared.
 * Copying values with a printed warning is the same class of mistake as
 * the scaffold that once staged its own Ed25519 private key.
 *
 * What replaces them mirrors the static `MCP_PRESETS` convention exactly,
 * so the generated preset is indistinguishable from a curated one at the
 * `applyPresetFields` call site:
 *
 *   - `env` entries       → `placement: "env"` fields; config keeps the key
 *                           with an empty string, as the curated presets do.
 *   - absolute-path args  → an `<UPPER_TOKEN>` in `args` plus a matching
 *                           `placement: "arg-replace"` field.
 *   - `headers` entries   → `placement: "header"` fields; the map is dropped
 *                           from config so no stray header ships.
 *   - a URL carrying a    → a single `placement: "url"` field; the URL is
 *     credential            removed from config entirely.
 *
 * A plain remote URL with no embedded credential is *kept*: it identifies
 * the server (it is what makes the preset that server) rather than
 * identifying the user.
 */

import type { McpPresetField } from "@/lib/claude/mcp-presets"
import type { McpTransport } from "@cognia/agent-config-types"

/** Result of stripping user-specific values out of one server config. */
export interface SanitizedConfig {
  config: Record<string, unknown>
  fields: McpPresetField[]
  /** Human-readable notes about what the author now has to fill in. */
  todos: string[]
}

/** Substrings that mark an env var / header / query param as a credential. */
const SECRET_MARKERS = [
  "key",
  "token",
  "secret",
  "password",
  "passwd",
  "credential",
  "auth",
  "session",
  "cookie",
  "signature",
  "private",
  "dsn",
  "webhook",
]

/** True when the name suggests the value is a credential. */
export function looksSecret(name: string): boolean {
  const lower = name.toLowerCase()
  return SECRET_MARKERS.some((marker) => lower.includes(marker))
}

/** `GITLAB_PERSONAL_ACCESS_TOKEN` → `Gitlab personal access token`. */
export function humanizeKey(key: string): string {
  const words = key
    .replace(/[_-]+/g, " ")
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .trim()
    .toLowerCase()
  if (!words) return key
  return words.charAt(0).toUpperCase() + words.slice(1)
}

/** True for a filesystem path that is specific to one machine. */
export function isAbsolutePathArg(value: string): boolean {
  if (value.startsWith("~/")) return true
  if (/^[A-Za-z]:[\\/]/.test(value)) return true
  // A bare "/" or "//" is not a meaningful path argument; require a segment.
  return /^\/[^/]/.test(value)
}

/**
 * Query parameter names that make a URL user-specific rather than
 * server-specific.
 */
function urlCarriesCredential(raw: string): boolean {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    // Not parseable — treat conservatively as user-specific so nothing
    // unexpected ships.
    return true
  }
  if (url.username || url.password) return true
  for (const name of url.searchParams.keys()) {
    if (looksSecret(name)) return true
  }
  return false
}

/** Derive a stable arg-replace token key from the path's last segment. */
function tokenKeyForPath(value: string, taken: Set<string>): string {
  const segment =
    value
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .pop() ?? "path"
  const base =
    segment
      .replace(/[^A-Za-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .toUpperCase() || "PATH"
  let key = base
  let n = 2
  while (taken.has(key)) {
    key = `${base}_${n}`
    n += 1
  }
  taken.add(key)
  return key
}

/**
 * Replace every user-specific value in `config` with a declared field.
 *
 * `config` is deep-cloned; the caller's object is never mutated.
 */
export function sanitizeMcpConfig(
  transport: McpTransport,
  config: Record<string, unknown>
): SanitizedConfig {
  const next = JSON.parse(JSON.stringify(config)) as Record<string, unknown>
  const fields: McpPresetField[] = []
  const todos: string[] = []
  const takenTokens = new Set<string>()

  // --- env ---------------------------------------------------------------
  const env = next.env
  if (env && typeof env === "object" && !Array.isArray(env)) {
    const blanked: Record<string, string> = {}
    for (const key of Object.keys(env as Record<string, unknown>)) {
      const secret = looksSecret(key)
      blanked[key] = ""
      fields.push({
        key,
        label: humanizeKey(key),
        placement: "env",
        ...(secret ? { secret: true } : {}),
      })
      todos.push(
        secret
          ? `env ${key} is a credential — its value was NOT copied; users supply it when they add the server`
          : `env ${key} was blanked — set a safe default in plugin.json if one exists`
      )
    }
    if (Object.keys(blanked).length > 0) {
      next.env = blanked
    } else {
      delete next.env
    }
  }

  // --- absolute path arguments -------------------------------------------
  const args = next.args
  if (Array.isArray(args)) {
    next.args = args.map((arg) => {
      if (typeof arg !== "string" || !isAbsolutePathArg(arg)) return arg
      const key = tokenKeyForPath(arg, takenTokens)
      const token = `<${key}>`
      fields.push({
        key,
        label: humanizeKey(key),
        placement: "arg-replace",
        token,
        description: "Path on this machine; the original value was not copied.",
      })
      todos.push(`argument ${token} is a machine-specific path users must supply`)
      return token
    })
  }

  // --- headers -----------------------------------------------------------
  const headers = next.headers
  if (headers && typeof headers === "object" && !Array.isArray(headers)) {
    for (const key of Object.keys(headers as Record<string, unknown>)) {
      fields.push({
        key,
        label: humanizeKey(key),
        placement: "header",
        secret: true,
      })
      todos.push(`header ${key} is user-specific — its value was NOT copied`)
    }
    // `applyPresetFields` rebuilds `headers` from the filled field values,
    // and skips empties, so shipping the map at all would only risk leaking.
    delete next.headers
  }

  // --- url ---------------------------------------------------------------
  if (transport !== "stdio" && typeof next.url === "string" && urlCarriesCredential(next.url)) {
    delete next.url
    fields.push({
      key: "url",
      label: "Server URL",
      placement: "url",
      description: "The original URL carried a credential and was not copied.",
    })
    todos.push("the server URL carried a credential — users supply the full URL")
  }

  return { config: next, fields, todos }
}
