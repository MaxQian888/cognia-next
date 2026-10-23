/**
 * Google Workspace document connection — settings + secret storage.
 *
 * Namespaced separately from the Drive BACKUP connection
 * (`lib/data/destinations/config.ts`, namespace `backup-destinations`) because
 * the two hold different scopes and may be different Google accounts. Sharing
 * a keyring key would silently couple them: reconnecting one would break the
 * other's identity.
 *
 * AppSettings stores preferences. The host keyring owns connection readiness,
 * account metadata, tokens and OAuth generations across all renderers.
 */

import type { GoogleDocsProviderSettings } from "@cognia/agent-config-types"
import { getSettings, saveSettings } from "@/lib/db/settings"
import { createKeyringStore, type KeyringStore } from "@/lib/credentials/keyring-store"
import { googleState, subscribeGoogleStateChanged } from "./state"

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
  let preferences: GoogleDocsProviderSettings = {}
  try {
    preferences = (await getSettings()).docsProviders?.google ?? {}
  } catch {
    /* Read-only UI remains usable while the DB is unavailable. */
  }
  return connectionSettings(preferences)
}

async function connectionSettings(
  preferences: GoogleDocsProviderSettings
): Promise<GoogleDocsProviderSettings> {
  try {
    const { state } = await googleState({ action: "snapshot" })
    return {
      ...preferences,
      connected: Boolean(state.tokens?.refreshToken),
      accountEmail: state.legacyMetadata
        ? preferences.accountEmail
        : (state.accountEmail ?? undefined),
      grantedScopes:
        state.tokens?.scope ?? (state.legacyMetadata ? preferences.grantedScopes : undefined),
    }
  } catch {
    // Never trust a singleton's stale connected flag if the credential owner
    // cannot confirm it. Authoritative operations surface their actual error.
    return { clientId: preferences.clientId, connected: false }
  }
}

type GoogleSettingsListener = (settings: GoogleDocsProviderSettings) => void
const settingsListeners = new Set<GoogleSettingsListener>()
let stopStateSubscription: (() => void) | undefined
let notificationVersion = 0
function notifySettings(settings: GoogleDocsProviderSettings) {
  for (const listener of settingsListeners) {
    try {
      listener(settings)
    } catch {
      /* A listener cannot undo a committed save. */
    }
  }
}
async function reloadConnection() {
  const version = ++notificationVersion
  const settings = await getGoogleDocsSettings()
  if (version === notificationVersion) notifySettings(settings)
}

/** Observe committed connection state in the credential-owning host. */
export function subscribeGoogleDocsSettings(listener: GoogleSettingsListener): () => void {
  settingsListeners.add(listener)
  if (!stopStateSubscription)
    stopStateSubscription = subscribeGoogleStateChanged(() => {
      void reloadConnection()
    })
  return () => {
    settingsListeners.delete(listener)
    if (!settingsListeners.size) {
      stopStateSubscription?.()
      stopStateSubscription = undefined
    }
  }
}

export async function updateGoogleDocsSettings(
  patch:
    | Partial<GoogleDocsProviderSettings>
    | ((current: GoogleDocsProviderSettings) => GoogleDocsProviderSettings)
): Promise<GoogleDocsProviderSettings> {
  // Apply inside the database's existing save queue, never to a stale snapshot.
  const saved = await saveSettings((settings) => {
    const providers = settings.docsProviders ?? {}
    const current = providers.google ?? {}
    const next = typeof patch === "function" ? patch(current) : { ...current, ...patch }
    return { docsProviders: { ...providers, google: next } }
  })
  // The DB keeps preferences; host state supplies credential readiness.
  const next = await connectionSettings(saved.docsProviders?.google ?? {})
  ++notificationVersion
  notifySettings(next)
  return next
}

export async function getGoogleClientSecret(): Promise<string | null> {
  return docsProviderSecrets().load(GOOGLE_CLIENT_SECRET_KEY)
}

export async function saveGoogleClientSecret(secret: string): Promise<void> {
  await docsProviderSecrets().save(GOOGLE_CLIENT_SECRET_KEY, secret)
}

export async function loadGoogleTokens(): Promise<GoogleOAuthTokens | null> {
  return (await googleState({ action: "snapshot" })).state.tokens
}

/** Legacy migration fixture/writer. Once the host record exists it is never reimported. */
export async function saveGoogleTokens(tokens: GoogleOAuthTokens): Promise<void> {
  await docsProviderSecrets().save(GOOGLE_TOKENS_KEY, JSON.stringify(tokens))
}

/** Forget the connection entirely: tokens out of the keyring, flags out of settings. */
export async function clearGoogleConnection(): Promise<void> {
  const { state } = await googleState({ action: "snapshot" })
  if (state.tokens) await googleState({ action: "invalidate", connection: state.connection })
  await updateGoogleDocsSettings((current) => ({ clientId: current.clientId, connected: false }))
}
