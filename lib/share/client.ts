// Owner-side share service: create / revoke / inspect public links.
//
// Create flow: generate a random key → encrypt the payload (key never uploaded)
// → POST the opaque envelope to the worker with the bearer secret → mint the
// shareable URL `${base}/share/view?c=<code>#k=<key>` → mirror it into Dexie.
// The viewer is the app's own `/share/view` route (ADR-0037 Phase 4); reads are
// public and handled there, not by this module.

import { generateShareKey, encodeShareKey } from "./keys"
import { encryptSharePayload } from "./crypto"
import { resolveShareEndpoint, type ShareEndpoint } from "./config"
import {
  recordSharedLink,
  markSharedLinkRevoked,
  getSharedLinkByCode,
  type SharedLinkRow,
} from "@/lib/db/shared-links"
import { getPluginEventHooks } from "@/lib/plugin/messaging/hooks-system"
import type { CreateShareRequest, CreateShareResponse, SharePayload, ShareStats } from "./types"

/** Raised when the upload bearer secret hasn't been configured yet. */
export class ShareNotConfiguredError extends Error {
  constructor() {
    super("Share service is not configured: set the worker URL and upload secret in Settings")
    this.name = "ShareNotConfiguredError"
  }
}

/** Raised for a non-2xx response from the worker. */
export class ShareRequestError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message)
    this.name = "ShareRequestError"
  }
}

export interface CreateShareInput {
  payload: SharePayload
  ttlSeconds?: number
  maxViews?: number
  burnAfterRead?: boolean
  /** Optional extra passphrase, shared out-of-band (never in the URL). */
  passphrase?: string
}

export interface CreatedShare {
  code: string
  /** Full shareable URL including the `#fragment` key. */
  url: string
  expiresAt?: number
}

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string }
    return body?.error ?? res.statusText
  } catch {
    return res.statusText
  }
}

function authHeaders(endpoint: ShareEndpoint): HeadersInit {
  if (!endpoint.uploadSecret) throw new ShareNotConfiguredError()
  return {
    Authorization: `Bearer ${endpoint.uploadSecret}`,
    "Content-Type": "application/json",
  }
}

/**
 * Headers for owner-only actions (stats / delete). Sends the per-share
 * `X-Owner-Token` when we have one (new shares) and the upload-secret bearer
 * when configured (legacy shares + the create gate). The worker accepts
 * whichever matches the share. Requires at least one credential.
 */
function ownerActionHeaders(endpoint: ShareEndpoint, ownerToken?: string): HeadersInit {
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (ownerToken) headers["X-Owner-Token"] = ownerToken
  if (endpoint.uploadSecret) headers["Authorization"] = `Bearer ${endpoint.uploadSecret}`
  if (!ownerToken && !endpoint.uploadSecret) throw new ShareNotConfiguredError()
  return headers
}

/** Create a share link and mirror it locally. */
export async function createShareLink(
  input: CreateShareInput,
  endpoint?: ShareEndpoint
): Promise<CreatedShare> {
  const ep = endpoint ?? (await resolveShareEndpoint())
  const headers = authHeaders(ep)

  const key = generateShareKey()
  const envelope = await encryptSharePayload(input.payload, key, input.passphrase)

  const body: CreateShareRequest = {
    envelope,
    ttlSeconds: input.ttlSeconds,
    maxViews: input.burnAfterRead ? 1 : input.maxViews,
    burnAfterRead: input.burnAfterRead,
  }

  const res = await fetch(`${ep.baseUrl}/v1/share`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new ShareRequestError(res.status, await readError(res))

  const { code, ownerToken, expiresAt } = (await res.json()) as CreateShareResponse
  const url = `${ep.baseUrl}/share/view?c=${code}#k=${encodeShareKey(key)}`

  const row: Omit<SharedLinkRow, "id" | "revoked"> = {
    code,
    kind: input.payload.kind,
    title: input.payload.title,
    url,
    createdAt: Date.now(),
    expiresAt,
    maxViews: body.maxViews,
    burnAfterRead: Boolean(input.burnAfterRead),
    hasPassphrase: Boolean(input.passphrase),
    ownerToken,
  }
  await recordSharedLink(row)

  // Plugin hook — fragment-stripped URL only (the `#k=` decryption key is
  // never exposed to plugin hooks). Best-effort.
  void getPluginEventHooks().dispatchShareLinkCreate({
    code,
    kind: input.payload.kind,
    title: input.payload.title,
    url: `${ep.baseUrl}/share/view?c=${code}`,
    expiresAt,
  })

  return { code, url, expiresAt }
}

/** Revoke a share on the worker and flag the local mirror. */
export async function revokeShareLink(code: string, endpoint?: ShareEndpoint): Promise<void> {
  const ep = endpoint ?? (await resolveShareEndpoint())
  const ownerToken = (await getSharedLinkByCode(code))?.ownerToken
  const res = await fetch(`${ep.baseUrl}/v1/share/${encodeURIComponent(code)}`, {
    method: "DELETE",
    headers: ownerActionHeaders(ep, ownerToken),
  })
  // 404 means it's already gone (expired/burned) — treat as success.
  if (!res.ok && res.status !== 404) {
    throw new ShareRequestError(res.status, await readError(res))
  }
  await markSharedLinkRevoked(code)
  void getPluginEventHooks().dispatchShareLinkRevoke(code)
}

/** Owner-only live stats (view count / expiry / revoked). Null if not found. */
export async function getShareStats(
  code: string,
  endpoint?: ShareEndpoint
): Promise<ShareStats | null> {
  const ep = endpoint ?? (await resolveShareEndpoint())
  const ownerToken = (await getSharedLinkByCode(code))?.ownerToken
  const res = await fetch(`${ep.baseUrl}/v1/share/${encodeURIComponent(code)}/stats`, {
    method: "GET",
    headers: ownerActionHeaders(ep, ownerToken),
  })
  if (res.status === 404) return null
  if (!res.ok) throw new ShareRequestError(res.status, await readError(res))
  return (await res.json()) as ShareStats
}
