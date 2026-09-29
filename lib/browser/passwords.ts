/**
 * Renderer transport for the Rust-only password vault (ADR-0201).
 *
 * Password values never cross this boundary except through
 * {@link revealCredential}, which the OS user-presence check gates in Rust.
 * Every other call carries or returns metadata only: saving sends a password
 * once, into Rust; filling asks Rust to put a stored password into the page.
 */
import { transport } from "@/lib/tauri"

export type PasswordSourceKind = "chromium" | "firefox"

export type PasswordSource = {
  browser: string
  label: string
  kind: PasswordSourceKind
  profiles: { id: string; name: string }[]
  supported: boolean
  reason: string | null
}

export type PasswordImportResult = {
  imported: number
  updated: number
  skipped: number
  skippedAppBound: number
  /** Machine-readable codes, e.g. `primary_password_set`. */
  errors: string[]
}

export const PASSWORD_CSV_FORMATS = [
  "chrome",
  "safari",
  "firefox",
  "1password",
  "bitwarden",
  "lastpass",
  "generic",
] as const
export type PasswordCsvFormat = (typeof PASSWORD_CSV_FORMATS)[number]

export type CredentialMeta = {
  id: string
  origin: string
  realm: string | null
  username: string
  source: string
  createdAt: number
  updatedAt: number
  lastUsedAt: number | null
  note: string | null
}

export type PendingSaveAction = "save" | "update" | "never" | "dismiss"

/**
 * How Rust classified a stashed submission against the vault
 * (`browser_password_pending_get`): `save` (new login), `update` (a saved
 * login for this username with a different password; `id` names it),
 * `unchanged` (same password already saved) or `suppressed` (the user chose
 * "never" for the site).
 */
export type PendingSaveKind = "save" | "update" | "unchanged" | "suppressed"

export type PendingSaveInfo = {
  origin: string
  username: string
  kind: PendingSaveKind
  /** The saved credential an `update` replaces. */
  id?: string
}

export type CredentialFillTarget = "embedded" | "local"

export type CredentialFillArgs = {
  target: CredentialFillTarget
  sessionId?: string
  pageId?: string
  credentialId?: string | null
  url: string
}

export type CredentialFillReason =
  "no_match" | "ambiguous" | "no_login_form" | "origin_mismatch" | "fill_failed"

export type CredentialFillResult = {
  filled: boolean
  username: string | null
  reason: CredentialFillReason | null
}

/** Error codes the OS user-presence gate rejects with. */
export const USER_PRESENCE_ERROR_CODES = [
  "user_presence_denied",
  "user_presence_unavailable",
  "user_presence_cancelled",
] as const
export type UserPresenceErrorCode = (typeof USER_PRESENCE_ERROR_CODES)[number]

/** Tauri rejects with the command's error string; always surface an `Error`. */
async function call<T>(command: string, args: Record<string, unknown>): Promise<T> {
  try {
    return await transport.call<T>(command, args)
  } catch (error) {
    if (error instanceof Error) throw error
    throw new Error(typeof error === "string" ? error : JSON.stringify(error))
  }
}

/** The user-presence code carried by an error, if any. */
export function userPresenceErrorCode(error: unknown): UserPresenceErrorCode | null {
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : ""
  return USER_PRESENCE_ERROR_CODES.find((code) => message.includes(code)) ?? null
}

export function listPasswordSources(): Promise<PasswordSource[]> {
  return call<PasswordSource[]>("browser_password_sources", {})
}

export function importPasswordsFromBrowser(
  browser: string,
  profile: string
): Promise<PasswordImportResult> {
  return call<PasswordImportResult>("browser_password_import_browser", { browser, profile })
}

export function importPasswordsFromCsv(
  path: string,
  format?: PasswordCsvFormat
): Promise<PasswordImportResult> {
  return call<PasswordImportResult>("browser_password_import_csv", {
    path,
    format: format ?? null,
  })
}

export function listCredentials(): Promise<CredentialMeta[]> {
  return call<CredentialMeta[]>("browser_password_list", {})
}

export function matchCredentials(url: string): Promise<CredentialMeta[]> {
  return call<CredentialMeta[]>("browser_password_matches", { url })
}

export function saveCredential(input: {
  origin: string
  username: string
  password: string
  note?: string
}): Promise<CredentialMeta> {
  return call<CredentialMeta>("browser_password_save", {
    input: {
      origin: input.origin,
      username: input.username,
      password: input.password,
      note: input.note ?? null,
    },
  })
}

export function updateCredential(input: {
  id: string
  username?: string
  password?: string
  note?: string
}): Promise<CredentialMeta> {
  return call<CredentialMeta>("browser_password_update", {
    input: {
      id: input.id,
      username: input.username ?? null,
      password: input.password ?? null,
      note: input.note ?? null,
    },
  })
}

export function deleteCredential(id: string): Promise<void> {
  return call<void>("browser_password_delete", { id })
}

/** Requires OS user presence; rejects with a `user_presence_*` code otherwise. */
export function revealCredential(id: string): Promise<{ password: string }> {
  return call<{ password: string }>("browser_password_reveal", { id })
}

/**
 * Requires OS user presence. Rust writes the clipboard and clears it after 30
 * seconds if it still holds the password; the value never reaches the renderer.
 */
export function copyCredential(id: string): Promise<void> {
  return call<void>("browser_password_copy", { id })
}

/**
 * Requires OS user presence. Rust then shows a native save dialog and writes a
 * Chrome-format CSV (owner-only, never through a symlink) where the user
 * chose; the renderer names no path. Resolves to `null` when the dialog was
 * cancelled.
 */
export function exportCredentials(): Promise<{ exported: number } | null> {
  return call<{ exported: number } | null>("browser_password_export", {})
}

/**
 * Classify a pending save in Rust against the real vault. Resolves to `null`
 * when the pending id expired or was already resolved.
 */
export function getPendingSave(pendingId: string): Promise<PendingSaveInfo | null> {
  return call<PendingSaveInfo | null>("browser_password_pending_get", { pendingId })
}

export function resolvePendingSave(
  pendingId: string,
  action: PendingSaveAction
): Promise<CredentialMeta | null> {
  return call<CredentialMeta | null>("browser_password_pending_resolve", { pendingId, action })
}

export async function fillCredential(args: CredentialFillArgs): Promise<CredentialFillResult> {
  const result = await call<Partial<CredentialFillResult> | null>("browser_credential_fill", {
    request: {
      target: args.target,
      sessionId: args.sessionId ?? null,
      pageId: args.pageId ?? null,
      credentialId: args.credentialId ?? null,
      url: args.url,
    },
  })
  return {
    filled: result?.filled === true,
    username: result?.username ?? null,
    reason: result?.reason ?? null,
  }
}
