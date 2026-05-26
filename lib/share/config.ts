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
