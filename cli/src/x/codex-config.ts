/**
 * Fallback Codex configuration for `cognia-agent x codex`.
 *
 * The launcher normally points Codex at the gateway with `-c` overrides on
 * the command line (`model_provider=cognia`, `model_providers.cognia.*`). If
 * an installed Codex refuses dotted `-c` keys, this writes a temporary
 * `CODEX_HOME` with an equivalent `config.toml` and links the user's own
 * `prompts/` into it. Authentication uses only the gateway key; the user's
 * `auth.json` is never shared, so token refresh cannot alter their login.
 * The user's real `~/.codex/config.toml` is never touched.
 *
 * Opt-in through `--codex-home-fallback` (or `COGNIA_X_CODEX_HOME_FALLBACK=1`).
 * It is a fallback and therefore dormant by default: the type below says so,
 * the CLI help says so, and `codex-config.test.ts` pins that nothing is
 * written unless the flag is on.
 */

import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export const CODEX_HOME_FALLBACK_ENV = "COGNIA_X_CODEX_HOME_FALLBACK"

/**
 * The wire Codex speaks to the gateway. Codex removed `wire_api = "chat"` in
 * February 2026 (openai/codex discussion #7782): a provider that still names
 * it fails at config load, before any request. The gateway's `/v1/responses`
 * translates streaming and tool calls onto every upstream protocol
 * (crates/cognia-gateway/src/translate/responses.rs), so Responses is the
 * only wire, for the argv overrides and the profile `config.toml` alike.
 */
export const CODEX_GATEWAY_WIRE_API = "responses"

/** The provider id the launch registers in Codex's `model_providers`. */
export const CODEX_GATEWAY_PROVIDER_ID = "cognia"

export function renderCodexConfigToml(gatewayBaseUrl: string, model?: string): string {
  const base = `${gatewayBaseUrl.replace(/\/$/, "")}/v1`
  const lines = [
    "# Written by cognia-agent x codex for ONE launch. Not your ~/.codex/config.toml.",
    `model_provider = ${JSON.stringify(CODEX_GATEWAY_PROVIDER_ID)}`,
    'cli_auth_credentials_store = "file"',
    ...(model ? [`model = ${JSON.stringify(model)}`] : []),
    "",
    `[model_providers.${CODEX_GATEWAY_PROVIDER_ID}]`,
    'name = "Cognia gateway"',
    `base_url = ${JSON.stringify(base)}`,
    'env_key = "COGNIA_GATEWAY_KEY"',
    "requires_openai_auth = false",
    `wire_api = ${JSON.stringify(CODEX_GATEWAY_WIRE_API)}`,
    "",
  ]
  return lines.join("\n")
}

export interface CodexConfigMigration {
  text: string
  /** True when the retired chat wire was rewritten. */
  migrated: boolean
}

/** The key path whose retired value is rewritten. */
const COGNIA_WIRE_PATH = ["model_providers", CODEX_GATEWAY_PROVIDER_ID, "wire_api"]
const COGNIA_PROVIDER_PATH = COGNIA_WIRE_PATH.slice(0, 2)

/** A `wire_api = "chat"` assignment inside an inline table, either quote style. */
const INLINE_CHAT_WIRE = /(\bwire_api\s*=\s*)(["'])chat\2/g

/**
 * Split a TOML key (`a.b`, `"a.b".c`, `a . 'b'`) into its parts, honouring
 * quotes so a quoted segment containing a dot stays one part. Returns `null`
 * for anything that is not a plain key.
 */
export function splitTomlKey(raw: string): string[] | null {
  const parts: string[] = []
  let current = ""
  let quote: '"' | "'" | null = null
  let quoted = false

  // Close the segment being read; a bare one must be a TOML bare key.
  const close = (): boolean => {
    if (quoted) {
      parts.push(current)
    } else {
      const bare = current.trim()
      if (!/^[A-Za-z0-9_-]+$/.test(bare)) return false
      parts.push(bare)
    }
    current = ""
    quoted = false
    return true
  }

  for (const char of raw) {
    if (quote) {
      if (char === quote) quote = null
      else current += char
      continue
    }
    if (char === ".") {
      if (!close()) return null
      continue
    }
    if (quoted) {
      // Only whitespace may follow a closing quote before the next dot.
      if (char.trim() !== "") return null
      continue
    }
    if (char === '"' || char === "'") {
      if (current.trim() !== "") return null
      quote = char
      quoted = true
      current = ""
      continue
    }
    current += char
  }
  if (quote) return null
  return close() ? parts : null
}

function samePath(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((part, i) => part === right[i])
}

/** Occurrences of a multi-line string delimiter on a line. */
function countDelimiter(line: string, delimiter: string): number {
  return line.split(delimiter).length - 1
}

/**
 * Bring a cognia-owned profile `config.toml` written by an older launcher up
 * to the wire Codex still accepts. The file is shared with Codex itself (it
 * records project trust and the user's own edits there), so this rewrites
 * ONE value — the cognia provider's `wire_api` when it is the retired `"chat"`
 * — and leaves every other byte, comment and line ending as it was. It
 * understands the three spellings a TOML file can use for that key: the
 * `[model_providers.cognia]` table, a dotted key from `[model_providers]` or
 * the root, and an inline `cognia = { ... }` table. A provider the user added
 * under another id is theirs and is not touched; Codex names it in its own
 * load error.
 */
export function migrateCodexProfileConfigToml(text: string): CodexConfigMigration {
  const lines = text.split("\n")
  let table: string[] = []
  let openMultiline: '"""' | "'''" | null = null
  let migrated = false

  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index]
    const carriage = raw.endsWith("\r") ? "\r" : ""
    const line = carriage ? raw.slice(0, -1) : raw

    if (openMultiline) {
      if (countDelimiter(line, openMultiline) % 2 === 1) openMultiline = null
      continue
    }

    const header = /^\s*\[(\[)?\s*([^\]]+?)\s*\](\])?\s*(?:#.*)?$/.exec(line)
    if (header) {
      table = splitTomlKey(header[2]) ?? ["\u0000unparsed"]
      continue
    }

    const assignment = /^(\s*)([^=#]+?)(\s*=\s*)(.*)$/.exec(line)
    if (assignment) {
      const key = splitTomlKey(assignment[2])
      const value = assignment[4]
      if (key) {
        const path = [...table, ...key]
        const scalar = /^(["'])chat\1(\s*(?:#.*)?)$/.exec(value)
        if (scalar && samePath(path, COGNIA_WIRE_PATH)) {
          lines[index] =
            `${assignment[1]}${assignment[2]}${assignment[3]}` +
            `${JSON.stringify(CODEX_GATEWAY_WIRE_API)}${scalar[2]}${carriage}`
          migrated = true
          continue
        }
        if (value.trimStart().startsWith("{") && samePath(path, COGNIA_PROVIDER_PATH)) {
          const rewritten = value.replace(
            INLINE_CHAT_WIRE,
            (_match, prefix: string) => `${prefix}${JSON.stringify(CODEX_GATEWAY_WIRE_API)}`
          )
          if (rewritten !== value) {
            lines[index] = `${assignment[1]}${assignment[2]}${assignment[3]}${rewritten}${carriage}`
            migrated = true
            continue
          }
        }
      }
      for (const delimiter of ['"""', "'''"] as const) {
        if (countDelimiter(value, delimiter) % 2 === 1) {
          openMultiline = delimiter
          break
        }
      }
    }
  }

  return { text: migrated ? lines.join("\n") : text, migrated }
}

export interface TemporaryCodexHome {
  dir: string
  /** Removes the temporary home. Idempotent. */
  cleanup: () => void
}

export interface TemporaryCodexHomeDeps {
  /** The user's real Codex home. Default `$CODEX_HOME` or `~/.codex`. */
  userCodexHome?: string
  mkdtemp?: (prefix: string) => string
  fs?: Pick<typeof fs, "existsSync" | "writeFileSync" | "symlinkSync" | "rmSync" | "mkdirSync">
}

/**
 * Create the temporary home with gateway-only authentication. Reuse prompts
 * when present, but never inspect, copy, or link the user's credentials.
 */
export function writeTemporaryCodexHome(
  input: { gatewayBaseUrl: string; model?: string },
  deps: TemporaryCodexHomeDeps = {}
): TemporaryCodexHome {
  const fsImpl = deps.fs ?? fs
  const mkdtemp =
    deps.mkdtemp ?? ((prefix: string) => fs.mkdtempSync(path.join(os.tmpdir(), prefix)))
  const userHome = deps.userCodexHome ?? process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex")
  const dir = mkdtemp("cognia-x-codex-")
  fsImpl.mkdirSync(dir, { recursive: true })
  fsImpl.writeFileSync(
    path.join(dir, "config.toml"),
    renderCodexConfigToml(input.gatewayBaseUrl, input.model)
  )
  const prompts = path.join(userHome, "prompts")
  if (fsImpl.existsSync(prompts)) {
    fsImpl.symlinkSync(prompts, path.join(dir, "prompts"))
  }
  let cleaned = false
  return {
    dir,
    cleanup: () => {
      if (cleaned) return
      cleaned = true
      fsImpl.rmSync(dir, { recursive: true, force: true })
    },
  }
}

/** Whether the fallback was requested, by flag or by environment. */
export function codexHomeFallbackRequested(
  flag: boolean | undefined,
  env: Record<string, string | undefined> = process.env
): boolean {
  return flag === true || env[CODEX_HOME_FALLBACK_ENV] === "1"
}
