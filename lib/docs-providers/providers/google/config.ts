/**
 * Google Workspace document connection — settings + secret storage.
 *
 * Namespaced separately from the Drive BACKUP connection
 * (`lib/data/destinations/config.ts`, namespace `backup-destinations`) because
 * the two hold different scopes and may be different Google accounts. Sharing
 * a keyring key would silently couple them: reconnecting one would break the
 * other's identity.
 *
 * Non-secret fields (client id, account email) live in `AppSettings`; the
 * client secret and the OAuth tokens live in the host keyring.
 */

import type { GoogleDocsProviderSettings } from "@cognia/agent-config-types"
import { getSettings, saveSettings } from "@/lib/db/settings"
import { createKeyringStore, type KeyringStore } from "@/lib/credentials/keyring-store"

export const DOCS_PROVIDER_KEYRING_NAMESPACE = "docs-providers"
export const GOOGLE_CLIENT_SECRET_KEY = "google-client-secret"
export const GOOGLE_TOKENS_KEY = "google-tokens"

/**
 * Read scopes. `drive.readonly` alone cannot read a Doc's body (Drive only
 * exports it) and cannot read a multi-tab spreadsheet, so all three are
 * requested together:
 *   - `drive.readonly`        — list/search files, export a Doc to markdown
 *   - `documents.readonly`    — Docs API structured read (fallback path)
 *   - `spreadsheets.readonly` — per-worksheet values, which Drive export cannot give
 *
 * NOT obtainable through Google's device-code flow (that flow allows only
 * email/profile/openid, drive.appdata and drive.file), which is why this
 * connection uses the installed-app loopback redirect instead.
 */
export const GOOGLE_DOCS_SCOPES = [
  "https://www.googleapis.com/auth/drive.readonly",
  "https://www.googleapis.com/auth/documents.readonly",
  "https://www.googleapis.com/auth/spreadsheets.readonly",
] as const

export const GOOGLE_DOCS_SCOPE_STRING = GOOGLE_DOCS_SCOPES.join(" ")

export interface GoogleOAuthTokens {
  accessToken: string
  refreshToken?: string
  /** Epoch ms. */
  expiresAt: number
  scope?: string
  tokenType?: string
}

let storeOverride: KeyringStore | null = null

/** Test seam: replace the keyring store. */
export function __setDocsProviderSecretsForTests(store: KeyringStore | null): void {
  storeOverride = store
}

export function docsProviderSecrets(): KeyringStore {
  return storeOverride ?? createKeyringStore(DOCS_PROVIDER_KEYRING_NAMESPACE)
}

export async function getGoogleDocsSettings(): Promise<GoogleDocsProviderSettings> {
  try {
    const settings = await getSettings()
    return settings.docsProviders?.google ?? {}
  } catch {
    return {}
  }
}

export async function updateGoogleDocsSettings(
  patch:
    | Partial<GoogleDocsProviderSettings>
    | ((current: GoogleDocsProviderSettings) => GoogleDocsProviderSettings)
): Promise<GoogleDocsProviderSettings> {
  const settings = await getSettings()
  const providers = settings.docsProviders ?? {}
  const current = providers.google ?? {}
  const next = typeof patch === "function" ? patch(current) : { ...current, ...patch }
  await saveSettings({ docsProviders: { ...providers, google: next } })
  return next
}

export async function getGoogleClientSecret(): Promise<string | null> {
  return docsProviderSecrets().load(GOOGLE_CLIENT_SECRET_KEY)
}

export async function saveGoogleClientSecret(secret: string): Promise<void> {
  await docsProviderSecrets().save(GOOGLE_CLIENT_SECRET_KEY, secret)
}

export async function loadGoogleTokens(): Promise<GoogleOAuthTokens | null> {
  const raw = await docsProviderSecrets().load(GOOGLE_TOKENS_KEY)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as Partial<GoogleOAuthTokens>
    if (typeof parsed.accessToken !== "string" || typeof parsed.expiresAt !== "number") return null
    return {
      accessToken: parsed.accessToken,
      refreshToken: typeof parsed.refreshToken === "string" ? parsed.refreshToken : undefined,
      expiresAt: parsed.expiresAt,
      scope: typeof parsed.scope === "string" ? parsed.scope : undefined,
      tokenType: typeof parsed.tokenType === "string" ? parsed.tokenType : undefined,
    }
  } catch {
    return null
  }
}

export async function saveGoogleTokens(tokens: GoogleOAuthTokens): Promise<void> {
  await docsProviderSecrets().save(GOOGLE_TOKENS_KEY, JSON.stringify(tokens))
}

/** Forget the connection entirely: tokens out of the keyring, flags out of settings. */
export async function clearGoogleConnection(): Promise<void> {
  await docsProviderSecrets().delete(GOOGLE_TOKENS_KEY)
  await updateGoogleDocsSettings((current) => ({
    clientId: current.clientId,
    connected: false,
  }))
}
