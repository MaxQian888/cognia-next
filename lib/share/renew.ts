// Owner-side "extend a share's lifetime" flow (ADR-0037).
//
// Kept in its own module rather than folded into `client.ts` so it composes
// cleanly with the create/revoke flow without enlarging that file. The small
// owner request resolver is shared with `client.ts`, so renewal uses the same
// original endpoint and credential boundary as stats and revocation.

import { updateSharedLinkExpiry } from "@/lib/db/shared-links"
import { proxyFetch } from "@/lib/network/proxy-fetch"

import { resolveShareOwnerRequest, ShareRequestError } from "./client"
import type { ShareEndpoint } from "./config"

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string }
    return body?.error ?? res.statusText
  } catch {
    return res.statusText
  }
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
  const { baseUrl, headers } = await resolveShareOwnerRequest(code, endpoint)
  const res = await proxyFetch(`${baseUrl}/v1/share/${encodeURIComponent(code)}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ ttlSeconds }),
  })
  if (!res.ok) throw new ShareRequestError(res.status, await readError(res))
  const { expiresAt } = (await res.json()) as { expiresAt: number }
  await updateSharedLinkExpiry(code, expiresAt)
  return expiresAt
}
