/**
 * Turning a Pro IDE failure into something a person can act on.
 *
 * Every lifecycle failure the host reports leads with a stable code
 * (`CODESERVER_*`, `crates/cognia-codeserver/src/error_code.rs`) followed by
 * detail written for a log. The pane used to print that whole string — an
 * English chain like `install code-server: download https://…: error sending
 * request` — in every locale. This maps each code to a translated message and
 * the next step, and keeps the raw text only for failures nobody classified.
 *
 * Exhaustive by construction: `Record<CodeServerErrorCode, …>` makes a new code
 * a type error here. `HOST_ERROR_CODES` is kept equal to the Rust enum by
 * `pnpm audit:pro-ide-constants`, and every key is asserted against both
 * catalogues by this module's test (`lint:i18n` cannot see a dynamic lookup).
 */

/** Codes the host (desktop or companion) reports. Mirrors `CodeServerErrorCode::ALL`. */
export const HOST_ERROR_CODES = [
  "CODESERVER_UNSUPPORTED_PLATFORM",
  "CODESERVER_DOWNLOAD_FAILED",
  "CODESERVER_DOWNLOAD_CANCELLED",
  "CODESERVER_CHECKSUM_MISMATCH",
  "CODESERVER_ARCHIVE_INVALID",
  "CODESERVER_INSTALL_FAILED",
  "CODESERVER_ROOT_INVALID",
  "CODESERVER_SPAWN_FAILED",
  "CODESERVER_HEALTH_TIMEOUT",
  "CODESERVER_NOT_RUNNING",
  "CODESERVER_UPGRADE_REQUIRED",
  "CODESERVER_RELAY_GRANT_REQUIRED",
] as const

/** Codes this renderer raises itself, for failures it detects on its own. */
export const RENDERER_ERROR_CODES = [
  /** The watchdog saw a healthy instance stop answering. */
  "CODESERVER_UNRESPONSIVE",
  /** The host or root changed while an open was in flight. */
  "CODESERVER_OPEN_SUPERSEDED",
  /** Another surface switched this workspace to the other profile. */
  "CODESERVER_PROFILE_CHANGED",
] as const

export const CODESERVER_ERROR_CODES = [...HOST_ERROR_CODES, ...RENDERER_ERROR_CODES] as const

export type CodeServerErrorCode = (typeof CODESERVER_ERROR_CODES)[number]

/** i18n namespace the keys below live under. */
export const CODESERVER_ERROR_NAMESPACE = "projectEditor.proIde.errors"

/** Key within {@link CODESERVER_ERROR_NAMESPACE} for each code. */
export const CODESERVER_ERROR_KEYS: Record<CodeServerErrorCode, string> = {
  CODESERVER_UNSUPPORTED_PLATFORM: "unsupportedPlatform",
  CODESERVER_DOWNLOAD_FAILED: "downloadFailed",
  CODESERVER_DOWNLOAD_CANCELLED: "downloadCancelled",
  CODESERVER_CHECKSUM_MISMATCH: "checksumMismatch",
  CODESERVER_ARCHIVE_INVALID: "archiveInvalid",
  CODESERVER_INSTALL_FAILED: "installFailed",
  CODESERVER_ROOT_INVALID: "rootInvalid",
  CODESERVER_SPAWN_FAILED: "spawnFailed",
  CODESERVER_HEALTH_TIMEOUT: "healthTimeout",
  CODESERVER_NOT_RUNNING: "notRunning",
  CODESERVER_UPGRADE_REQUIRED: "upgradeRequired",
  CODESERVER_RELAY_GRANT_REQUIRED: "relayGrantRequired",
  CODESERVER_UNRESPONSIVE: "unresponsive",
  CODESERVER_OPEN_SUPERSEDED: "openSuperseded",
  CODESERVER_PROFILE_CHANGED: "profileChanged",
}

/** Key used for a failure that carries no known code. */
export const CODESERVER_ERROR_FALLBACK_KEY = "unknown"

/** Every `<key>.message` / `<key>.hint` this module can ask a catalogue for. */
export const ALL_CODESERVER_ERROR_KEYS: readonly string[] = [
  ...CODESERVER_ERROR_CODES.map((code) => CODESERVER_ERROR_KEYS[code]),
  CODESERVER_ERROR_FALLBACK_KEY,
].flatMap((key) => [`${key}.message`, `${key}.hint`])

const CODE_PATTERN = /\bCODESERVER_[A-Z_]+\b/g
const KNOWN = new Set<string>(CODESERVER_ERROR_CODES)

/** The text of a failure, whatever shape it arrived in. */
export function codeServerErrorText(error: unknown): string {
  if (typeof error === "string") return error
  if (error && typeof error === "object") {
    const { code, message } = error as { code?: unknown; message?: unknown }
    // A companion RPC error carries the code separately as well as in the
    // message; keep both so a message that lost its prefix still classifies.
    if (typeof message === "string") {
      return typeof code === "string" && KNOWN.has(code) && !message.includes(code)
        ? `${code}: ${message}`
        : message
    }
  }
  return String(error)
}

/** The first known code in a failure's text, or `null`. */
export function codeServerErrorCode(error: unknown): CodeServerErrorCode | null {
  for (const match of codeServerErrorText(error).matchAll(CODE_PATTERN)) {
    if (KNOWN.has(match[0])) return match[0] as CodeServerErrorCode
  }
  return null
}

export interface CodeServerErrorView {
  code: CodeServerErrorCode | null
  message: string
  hint: string
  /** The raw text, kept only when no code explains it. */
  detail: string | null
}

/** Minimal translator scoped to {@link CODESERVER_ERROR_NAMESPACE}. */
export type CodeServerErrorTranslator = (key: string) => string

/** What to show for a failed Pro IDE operation. */
export function describeCodeServerError(
  error: unknown,
  t: CodeServerErrorTranslator
): CodeServerErrorView {
  const code = codeServerErrorCode(error)
  const key = code ? CODESERVER_ERROR_KEYS[code] : CODESERVER_ERROR_FALLBACK_KEY
  const text = codeServerErrorText(error).trim()
  return {
    code,
    message: t(`${key}.message`),
    hint: t(`${key}.hint`),
    detail: code || !text ? null : text,
  }
}
