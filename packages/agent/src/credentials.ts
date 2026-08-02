/**
 * Credential *references* — never credential values.
 *
 * The rule this module enforces: an embedder hands the SDK a POINTER to a
 * secret (a profile in `~/.cognia/credentials.json`, or the name of an
 * environment variable), and the SDK resolves it. A raw key never travels
 * through an SDK option object.
 *
 * That is not just hygiene. An options object is the single most-logged,
 * most-serialized value in an embedding application: it ends up in structured
 * logs, crash reports, `JSON.stringify(options)` debug lines, and — because
 * this SDK's whole point is automation — in CI job definitions. A reference
 * that leaks is a filename. A key that leaks is a key.
 *
 * {@link CogniaCredentialRef} makes the safe shape the ONLY representable one,
 * and {@link assertNoInlineSecret} catches the case types cannot: a plain
 * object built at runtime from JSON, where TypeScript never looked.
 */

import fs from "node:fs"

import type { AgentStructuredError } from "@cognia/agent-config-types/agent-run-result"

import { credentialsFileSchema } from "@/cli/src/config/schema"
import { credentialsPath } from "@/cli/src/config/load"

/**
 * How the SDK should obtain the provider secret for a run.
 *
 * Exactly one of the two forms, and neither carries the secret itself.
 */
export type CogniaCredentialRef =
  | {
      /**
       * Name of a provider entry in `~/.cognia/credentials.json` (the same file
       * `cognia-agent login` writes). This is the normal form.
       */
      credentialProfileRef: string
      credentialEnv?: never
    }
  | {
      /**
       * Name of an environment variable holding the secret, e.g.
       * `"ANTHROPIC_API_KEY"`. The VARIABLE NAME, not its value.
       */
      credentialEnv: string
      credentialProfileRef?: never
    }

/** Field names that would mean an embedder inlined a secret. */
const INLINE_SECRET_FIELDS = [
  "apiKey",
  "api_key",
  "authToken",
  "auth_token",
  "token",
  "secret",
  "password",
  "accessToken",
  "access_token",
] as const

/**
 * Reject an options object that carries a secret inline.
 *
 * Types already forbid it, but this SDK is consumed from JavaScript and from
 * config files deserialized at runtime, where the compiler never ran. Failing
 * loudly here is the difference between "your key is ignored" (and the run
 * mysteriously falls back to some other credential) and "your key is in a log
 * file". Returns a structured error rather than throwing so every surface —
 * SDK promise, CLI exit code, RPC response — reports it identically.
 */
export function assertNoInlineSecret(value: unknown): AgentStructuredError | null {
  if (!value || typeof value !== "object") return null
  const record = value as Record<string, unknown>
  const offending = INLINE_SECRET_FIELDS.filter((field) => record[field] !== undefined)
  if (offending.length === 0) return null
  return {
    code: "config_error",
    message:
      `credentials must be passed by reference, not by value ` +
      `(remove ${offending.join(", ")}; use credentialProfileRef or credentialEnv)`,
    // Deliberately reports only the FIELD NAMES. Echoing the value back into a
    // structured error would recreate exactly the leak this check exists to
    // prevent — the error object is itself logged.
    detail: { fields: offending },
  }
}

/** A resolved secret plus where it came from, for the audit trail. */
export interface ResolvedCredential {
  /** The secret. Never placed in an event, result, log line or error. */
  secret: string
  /** Human-readable provenance, safe to log: `"env:ANTHROPIC_API_KEY"`. */
  source: string
}

export interface ResolveCredentialOptions {
  ref: CogniaCredentialRef
  /** CLI home holding `credentials.json`. */
  home: string
  env?: Record<string, string | undefined>
  readFile?: (absPath: string) => string | null
}

function defaultReadFile(absPath: string): string | null {
  try {
    return fs.readFileSync(absPath, "utf8")
  } catch {
    return null
  }
}

/**
 * Resolve a reference to the secret it names.
 *
 * A reference that resolves to nothing is a hard `config_error`, never a silent
 * fall-through to some other credential the process happens to have — an
 * embedder that named a profile and got a different account's key would have no
 * way to notice until the bill arrived.
 */
export function resolveCredential(
  options: ResolveCredentialOptions
): { ok: true; credential: ResolvedCredential } | { ok: false; error: AgentStructuredError } {
  const inline = assertNoInlineSecret(options.ref)
  if (inline) return { ok: false, error: inline }

  const env = options.env ?? process.env
  const readFile = options.readFile ?? defaultReadFile

  if (options.ref.credentialEnv) {
    const name = options.ref.credentialEnv
    const secret = env[name]?.trim()
    if (!secret) {
      return {
        ok: false,
        error: {
          code: "config_error",
          message: `environment variable ${name} is not set (credentialEnv)`,
          detail: { credentialEnv: name },
        },
      }
    }
    return { ok: true, credential: { secret, source: `env:${name}` } }
  }

  const profile = options.ref.credentialProfileRef?.trim()
  if (!profile) {
    return {
      ok: false,
      error: {
        code: "config_error",
        message: "credentials require credentialProfileRef or credentialEnv",
      },
    }
  }

  const file = credentialsPath(options.home)
  const raw = readFile(file)
  if (raw === null) {
    return {
      ok: false,
      error: {
        code: "config_error",
        message: `no credentials file at ${file} (credentialProfileRef "${profile}")`,
        detail: { credentialProfileRef: profile, file },
      },
    }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {
      ok: false,
      error: {
        code: "config_error",
        message: `credentials file ${file} is not valid JSON`,
        detail: { file },
      },
    }
  }

  // Reuse the CLI's own schema so the SDK and `cognia-agent login` can never
  // disagree about what a valid credentials file is.
  const validated = credentialsFileSchema.safeParse(parsed)
  if (!validated.success) {
    return {
      ok: false,
      error: {
        code: "config_error",
        message: `credentials file ${file} does not match the expected shape`,
        detail: { file },
      },
    }
  }

  const entry = validated.data.providers?.[profile]
  const secret = entry?.apiKey ?? entry?.authToken
  if (!secret) {
    const known = Object.keys(validated.data.providers ?? {})
    return {
      ok: false,
      error: {
        code: "config_error",
        message:
          `credentialProfileRef "${profile}" is not in ${file}` +
          (known.length > 0 ? ` (known: ${known.join(", ")})` : ""),
        detail: { credentialProfileRef: profile, known },
      },
    }
  }

  return { ok: true, credential: { secret, source: `profile:${profile}` } }
}
