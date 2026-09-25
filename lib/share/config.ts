// Endpoint + secret resolution for the share service. Mirrors the signaling
// pattern: a build-time default (`NEXT_PUBLIC_SHARE_URL`), overridable per
// install via `AppSettings.shareUrl`. The upload bearer secret lives in the OS
// keyring (never in settings / IndexedDB plaintext).

import { getSettings } from "@/lib/db/settings"
import { getSecret, setSecret, clearSecret, type KeyringRef } from "@/lib/keyring"

export const DEFAULT_SHARE_URL = process.env.NEXT_PUBLIC_SHARE_URL ?? "https://share.cognia.cn"

export const SHARE_UPLOAD_SECRET_REF: KeyringRef = {
  namespace: "share-links",
  key: "upload-bearer-secret",
}

export interface ShareEndpoint {
  /** Base URL with no trailing slash. */
  baseUrl: string
  /** Bearer secret for write/delete; empty string when unconfigured. */
  uploadSecret: string
}

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "")
}

/**
 * The endpoint for a reader with no open account: the build-time default.
 *
 * The share viewer's guest mode (ADR-0037, "The anonymous visitor") reads from
 * here instead of {@link resolveShareEndpoint}. A visitor has no settings row
 * and no keyring, and asking for either reaches `getDb()`, which with no
 * account selected opens (and so creates) the legacy app database in a
 * stranger's browser. The public deployment is built with
 * `NEXT_PUBLIC_SHARE_URL` naming its own host, so this is the right answer
 * there without a lookup.
 */
export function defaultShareBaseUrl(): string {
  return normalizeBaseUrl(DEFAULT_SHARE_URL)
}

/** Resolve the live endpoint from settings + keyring. */
export async function resolveShareEndpoint(): Promise<ShareEndpoint> {
  const settings = await getSettings()
  const baseUrl = normalizeBaseUrl(settings?.shareUrl || DEFAULT_SHARE_URL)
  const uploadSecret = (await getSecret(SHARE_UPLOAD_SECRET_REF)) ?? ""
  return { baseUrl, uploadSecret }
}

export async function setShareUploadSecret(secret: string): Promise<void> {
  if (secret) await setSecret(SHARE_UPLOAD_SECRET_REF, secret)
  else await clearSecret(SHARE_UPLOAD_SECRET_REF)
}

export async function hasShareUploadSecret(): Promise<boolean> {
  return Boolean(await getSecret(SHARE_UPLOAD_SECRET_REF))
}
