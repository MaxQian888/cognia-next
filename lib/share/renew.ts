// Owner-side "extend a share's lifetime" flow (ADR-0037).
//
// Kept in its own module rather than folded into `client.ts` so it composes
// cleanly with the create/revoke flow without enlarging that file. The small
// owner-action auth + error-read helpers mirror `client.ts` (X-Owner-Token,
// falling back to the upload-secret bearer for legacy shares) — including
// `proxyFetch`, for the same reason `client.ts` uses it.

import { getSharedLinkByCode, updateSharedLinkExpiry } from "@/lib/db/shared-links"
import { proxyFetch } from "@/lib/network/proxy-fetch"

import { ShareNotConfiguredError, ShareRequestError } from "./client"
import { resolveShareEndpoint, type ShareEndpoint } from "./config"

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string }
    return body?.error ?? res.statusText
  } catch {
    return res.statusText
  }
}

/** Owner-only action headers — the per-share token when we have one, else the
 * upload-secret bearer (legacy shares). Requires at least one credential. */
function ownerActionHeaders(endpoint: ShareEndpoint, ownerToken?: string): HeadersInit {
  const headers: Record<string, string> = { "Content-Type": "application/json" }
  if (ownerToken) headers["X-Owner-Token"] = ownerToken
  if (endpoint.uploadSecret) headers["Authorization"] = `Bearer ${endpoint.uploadSecret}`
  if (!ownerToken && !endpoint.uploadSecret) throw new ShareNotConfiguredError()
  return headers
}

/**
 * Extend a share's lifetime to `ttlSeconds` from now (the worker clamps to its
 * hard ceiling), then mirror the new expiry into the local `sharedLinks` row.
 * Returns the new `expiresAt` (epoch ms).
 */
export async function extendShareLink(
  code: string,
  ttlSeconds: number,
  endpoint?: ShareEndpoint
): Promise<number> {
  const ep = endpoint ?? (await resolveShareEndpoint())
  const ownerToken = (await getSharedLinkByCode(code))?.ownerToken
  const res = await proxyFetch(`${ep.baseUrl}/v1/share/${encodeURIComponent(code)}`, {
    method: "PATCH",
    headers: ownerActionHeaders(ep, ownerToken),
    body: JSON.stringify({ ttlSeconds }),
  })
  if (!res.ok) throw new ShareRequestError(res.status, await readError(res))
  const { expiresAt } = (await res.json()) as { expiresAt: number }
  await updateSharedLinkExpiry(code, expiresAt)
  return expiresAt
}
