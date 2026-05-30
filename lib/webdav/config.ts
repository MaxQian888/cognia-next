// WebDAV connection config + credential resolution. Mirrors `lib/share/config.ts`:
// non-secret fields (url/user/dir) live in `AppSettings.webdavSync`; the server
// password lives in the OS keyring, never in IndexedDB plaintext.

import { getSettings } from "@/lib/db/settings"
import { getSecret, setSecret, clearSecret, type KeyringRef } from "@/lib/keyring"
import { createWebDavClient, type WebDavClient } from "./client"

export const DEFAULT_WEBDAV_REMOTE_DIR = "/cognia-backups"

export const WEBDAV_PASSWORD_REF: KeyringRef = {
  namespace: "webdav-sync",
  key: "server-password",
}

/** Fully resolved config — only returned when sync is enabled AND complete. */
export interface WebDavSyncConfig {
  baseUrl: string
  username: string
  remoteDir: string
  password: string
}

function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "")
}

function normalizeDir(dir: string): string {
  const trimmed = dir.trim().replace(/\/+$/, "")
  if (!trimmed) return DEFAULT_WEBDAV_REMOTE_DIR
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`
}

/**
 * Resolve the live WebDAV config from settings + keyring. Returns `null` when
 * sync is disabled or any required field (url / username / password) is missing.
 */
export async function resolveWebDavConfig(): Promise<WebDavSyncConfig | null> {
  const settings = await getSettings()
  const cfg = settings.webdavSync
  if (!cfg?.enabled) return null

  const baseUrl = normalizeBaseUrl(cfg.baseUrl ?? "")
  const username = (cfg.username ?? "").trim()
  if (!baseUrl || !username) return null

  const password = (await getSecret(WEBDAV_PASSWORD_REF)) ?? ""
  if (!password) return null

  return {
    baseUrl,
    username,
    remoteDir: normalizeDir(cfg.remoteDir ?? DEFAULT_WEBDAV_REMOTE_DIR),
    password,
  }
}

/** Upsert (or clear, when empty) the WebDAV server password in the keyring. */
export async function setWebDavPassword(password: string): Promise<void> {
  if (password) await setSecret(WEBDAV_PASSWORD_REF, password)
  else await clearSecret(WEBDAV_PASSWORD_REF)
}

export async function hasWebDavPassword(): Promise<boolean> {
  return Boolean(await getSecret(WEBDAV_PASSWORD_REF))
}

export async function getWebDavPassword(): Promise<string | null> {
  return getSecret(WEBDAV_PASSWORD_REF)
}

/**
 * Build a platform-wired client from the resolved config. Returns the client +
 * config (the config carries `remoteDir`, which upload/restore need), or `null`
 * when sync isn't configured. Throws only if the platform transport is
 * unavailable (web).
 */
export async function makeWebDavClient(): Promise<{
  client: WebDavClient
  config: WebDavSyncConfig
} | null> {
  const config = await resolveWebDavConfig()
  if (!config) return null
  const client = createWebDavClient(
    { baseUrl: config.baseUrl, username: config.username, password: config.password },
    { trustSelfSigned: true }
  )
  return { client, config }
}
