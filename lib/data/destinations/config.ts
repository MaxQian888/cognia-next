/**
 * Backup-destination configuration + secrets (spec 2026-08-16, D).
 *
 * Non-secret fields live in `AppSettings.backupDestinations`; secrets live in
 * the host keyring under ONE namespace so a headless brain (secret store via
 * the service transport) and the desktop (OS keyring) share the same code:
 *
 *   backup-destinations / github-token                 — GitHub PAT (keyring credential mode)
 *   backup-destinations / google-drive-client-secret   — OAuth client secret (user supplied)
 *   backup-destinations / google-drive-tokens          — JSON `GoogleOAuthTokens`
 *
 * `convex` stays in the `BackupDestination` enum only so persisted rows keep
 * type-checking; it is DEPRECATED — it would require the user to deploy
 * Cognia-supplied functions into their own Convex project, which is not a
 * backup destination a product can promise.
 */

import type {
  BackupDestinationsSettings,
  GithubBackupDestinationSettings,
  GoogleDriveBackupDestinationSettings,
} from "@cognia/agent-config-types"
import type { BackupDestination } from "@/types/scheduler"
import { getSettings, saveSettings } from "@/lib/db/settings"
import { createKeyringStore, type KeyringStore } from "@/lib/credentials/keyring-store"

export const BACKUP_DESTINATION_KEYRING_NAMESPACE = "backup-destinations"
export const GITHUB_TOKEN_KEY = "github-token"
export const GOOGLE_DRIVE_CLIENT_SECRET_KEY = "google-drive-client-secret"
export const GOOGLE_DRIVE_TOKENS_KEY = "google-drive-tokens"

export const DEFAULT_GITHUB_BACKUP_PATH = "cognia-backups"
export const DEFAULT_GOOGLE_DRIVE_FOLDER_NAME = "Cognia Backups"

/** Destinations that have a wired backend on this build. */
export const SUPPORTED_BACKUP_DESTINATIONS: readonly BackupDestination[] = Object.freeze([
  "local",
  "webdav",
  "github",
  "googledrive",
  "all",
] as const)

/** Destinations kept in the enum for persisted rows but no longer offered. */
export const DEPRECATED_BACKUP_DESTINATIONS: readonly BackupDestination[] = Object.freeze([
  "convex",
] as const)

export function isDeprecatedBackupDestination(destination: string | undefined): boolean {
  return (DEPRECATED_BACKUP_DESTINATIONS as readonly string[]).includes(destination ?? "")
}

let storeOverride: KeyringStore | null = null

/** Test seam: replace the keyring store. */
export function __setBackupDestinationSecretStoreForTesting(store: KeyringStore | null): void {
  storeOverride = store
}

export function backupDestinationSecrets(): KeyringStore {
  return storeOverride ?? createKeyringStore(BACKUP_DESTINATION_KEYRING_NAMESPACE)
}

export async function getBackupDestinationsSettings(): Promise<BackupDestinationsSettings> {
  try {
    const settings = await getSettings()
    return settings.backupDestinations ?? {}
  } catch {
    return {}
  }
}

export async function updateBackupDestinationsSettings(
  patch:
    | Partial<BackupDestinationsSettings>
    | ((current: BackupDestinationsSettings) => BackupDestinationsSettings)
): Promise<BackupDestinationsSettings> {
  const settings = await getSettings()
  const current = settings.backupDestinations ?? {}
  const next = typeof patch === "function" ? patch(current) : { ...current, ...patch }
  await saveSettings({ backupDestinations: next })
  return next
}

// ── GitHub ──────────────────────────────────────────────────────────────────

/** Normalised, enabled GitHub config — `null` when disabled/incomplete. */
export interface ResolvedGithubBackupConfig {
  owner: string
  repo: string
  repoFullName: string
  branch?: string
  path: string
  credential: NonNullable<GithubBackupDestinationSettings["credential"]>
}

export function parseRepoFullName(
  input: string | undefined
): { owner: string; repo: string } | null {
  const trimmed = (input ?? "")
    .trim()
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/\.git$/i, "")
  const match = /^([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9._-]+)$/.exec(trimmed)
  if (!match) return null
  return { owner: match[1], repo: match[2] }
}

export function normalizeGithubPath(input: string | undefined): string {
  const trimmed = (input ?? "").trim().replace(/^\/+|\/+$/g, "")
  if (!trimmed) return DEFAULT_GITHUB_BACKUP_PATH
  if (trimmed.split("/").some((segment) => segment === "." || segment === "..")) {
    return DEFAULT_GITHUB_BACKUP_PATH
  }
  return trimmed
}

export function resolveGithubBackupConfig(
  settings: GithubBackupDestinationSettings | undefined,
  options: { requireEnabled?: boolean } = {}
): ResolvedGithubBackupConfig | null {
  if (!settings) return null
  if ((options.requireEnabled ?? true) && !settings.enabled) return null
  const parsed = parseRepoFullName(settings.repo)
  if (!parsed) return null
  return {
    owner: parsed.owner,
    repo: parsed.repo,
    repoFullName: `${parsed.owner}/${parsed.repo}`,
    branch: settings.branch?.trim() || undefined,
    path: normalizeGithubPath(settings.path),
    credential: settings.credential ?? { kind: "keyring" },
  }
}

export async function getGithubBackupToken(
  credential: NonNullable<GithubBackupDestinationSettings["credential"]>
): Promise<string | null> {
  if (credential.kind === "keyring") {
    return backupDestinationSecrets().load(GITHUB_TOKEN_KEY)
  }
  // Reuse an existing GitHub auth session (built-in github-pat / github-app
  // providers, ADR-0026 integrations). App sessions mint short-lived
  // installation tokens through the provider's request-credential hook.
  const { getProvider } = await import("@/lib/plugin/auth/auth-provider-registry")
  const provider = getProvider(credential.providerId)
  if (!provider) return null
  const sessions = await provider.getSessions(undefined, { silent: true })
  const session = sessions.find((s) => s.id === credential.sessionId)
  if (!session) return null
  if (credential.providerId === "github-app" && provider.resolveRequestCredential) {
    const resolved = await provider.resolveRequestCredential(session.id, {
      accountId: session.account.id,
      origin: "https://api.github.com",
    })
    return resolved.accessToken
  }
  return session.accessToken
}

export async function setGithubBackupToken(token: string): Promise<void> {
  const trimmed = token.trim()
  if (!trimmed) throw new Error("GitHub token must not be empty")
  await backupDestinationSecrets().save(GITHUB_TOKEN_KEY, trimmed)
}

export async function clearGithubBackupToken(): Promise<void> {
  await backupDestinationSecrets().delete(GITHUB_TOKEN_KEY)
}

// ── Google Drive ────────────────────────────────────────────────────────────

export interface GoogleOAuthTokens {
  accessToken: string
  refreshToken?: string
  /** Epoch ms when `accessToken` expires. */
  expiresAt: number
  scope?: string
  tokenType?: string
}

export interface ResolvedGoogleDriveBackupConfig {
  clientId: string
  folderName: string
  folderId?: string
}

export function resolveGoogleDriveBackupConfig(
  settings: GoogleDriveBackupDestinationSettings | undefined,
  options: { requireEnabled?: boolean } = {}
): ResolvedGoogleDriveBackupConfig | null {
  if (!settings) return null
  if ((options.requireEnabled ?? true) && !settings.enabled) return null
  const clientId = settings.clientId?.trim()
  if (!clientId) return null
  return {
    clientId,
    folderName: settings.folderName?.trim() || DEFAULT_GOOGLE_DRIVE_FOLDER_NAME,
    folderId: settings.folderId?.trim() || undefined,
  }
}

export async function getGoogleDriveClientSecret(): Promise<string | null> {
  return backupDestinationSecrets().load(GOOGLE_DRIVE_CLIENT_SECRET_KEY)
}

export async function setGoogleDriveClientSecret(secret: string): Promise<void> {
  const trimmed = secret.trim()
  if (!trimmed) throw new Error("Google OAuth client secret must not be empty")
  await backupDestinationSecrets().save(GOOGLE_DRIVE_CLIENT_SECRET_KEY, trimmed)
}

export async function loadGoogleDriveTokens(): Promise<GoogleOAuthTokens | null> {
  const raw = await backupDestinationSecrets().load(GOOGLE_DRIVE_TOKENS_KEY)
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

export async function saveGoogleDriveTokens(tokens: GoogleOAuthTokens): Promise<void> {
  await backupDestinationSecrets().save(GOOGLE_DRIVE_TOKENS_KEY, JSON.stringify(tokens))
}

export async function clearGoogleDriveTokens(): Promise<void> {
  await backupDestinationSecrets().delete(GOOGLE_DRIVE_TOKENS_KEY)
}

// ── Aggregate readiness (used by the scheduler dialog + host matrix) ────────

export type BackupDestinationReadiness =
  | { destination: BackupDestination; state: "ready" }
  | { destination: BackupDestination; state: "not-configured"; reason: string }
  | { destination: BackupDestination; state: "deprecated" }

/** Which remote destinations are configured well enough to be scheduled. */
export async function describeBackupDestinationReadiness(): Promise<BackupDestinationReadiness[]> {
  const settings = await getBackupDestinationsSettings()
  const out: BackupDestinationReadiness[] = [{ destination: "local", state: "ready" }]
  const github = resolveGithubBackupConfig(settings.github)
  out.push(
    github
      ? { destination: "github", state: "ready" }
      : { destination: "github", state: "not-configured", reason: "github" }
  )
  const drive = resolveGoogleDriveBackupConfig(settings.googleDrive)
  const driveTokens = drive ? await loadGoogleDriveTokens() : null
  out.push(
    drive && driveTokens?.refreshToken
      ? { destination: "googledrive", state: "ready" }
      : { destination: "googledrive", state: "not-configured", reason: "googledrive" }
  )
  out.push({ destination: "convex", state: "deprecated" })
  return out
}
