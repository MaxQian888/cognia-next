/**
 * The sign-ins the official account knows for a person, read from its ID
 * token (ADR-0215 §2).
 *
 * A self-hosted deployment answers "which GitHub and Feishu accounts is this
 * person?" from the collaboration server, which asks Logto's management API
 * (`GET /v1/account/memberships`). The official account has no collaboration
 * server in front of it and no management API to ask; its issuer puts the
 * same answer in the ID token instead, as `cognia_identities`:
 *
 * ```json
 * [{ "provider": "lark", "tenant": "<tenant_key>", "subject": "<union_id>" },
 *  { "provider": "github", "subject": "583231" }]
 * ```
 *
 * The result has the collaboration server's shape, so the same linker
 * (`link-signed-in-identities.ts`) and the Feishu principal join take it.
 *
 * # Trust
 *
 * The ID token arrived over TLS from the issuer in the same token response
 * as the access token the host verifies. These identities are links for the
 * local person directory, never authorization.
 */

import { decodeJwtPayload } from "@/lib/security/jwt-payload"

import type { CollabExternalIdentity } from "@/lib/collab/client"
import type { LogtoSession } from "@/lib/logto/client"

export const IDENTITIES_CLAIM = "cognia_identities"

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined
}

/** The identities an ID token lists, skipping any entry it cannot read. */
export function identitiesFromIdToken(idToken: string | undefined): CollabExternalIdentity[] {
  const claim = idToken ? decodeJwtPayload(idToken)?.[IDENTITIES_CLAIM] : undefined
  if (!Array.isArray(claim)) return []
  const identities: CollabExternalIdentity[] = []
  for (const entry of claim) {
    if (!entry || typeof entry !== "object") continue
    const record = entry as Record<string, unknown>
    const provider = text(record.provider)
    const subject = text(record.subject)
    if (!provider || !subject) continue
    const tenant = text(record.tenant)
    identities.push({ provider, subject, ...(tenant ? { tenant } : {}) })
  }
  return identities
}

/** {@link identitiesFromIdToken} for a session. */
export function issuerIdentities(session: Pick<LogtoSession, "idToken">): CollabExternalIdentity[] {
  return identitiesFromIdToken(session.idToken)
}
