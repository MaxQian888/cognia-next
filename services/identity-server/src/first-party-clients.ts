/**
 * The Cognia apps as OAuth clients (ADR-0215 §2).
 *
 * Both are public PKCE clients seeded by `migrations/0002_first_party_clients.sql`
 * with fixed ids, owned by nobody (`userId` NULL: an owner's deletion would
 * cascade to the client). Client management over HTTP is closed
 * (`clientPrivileges` denies everything), so these rows are the only clients.
 *
 * - `cognia-app`: desktop, phone and CLI. Redirects to the RFC 8252 private-use
 *   URI `cn.cognia.app:/auth/callback` and to loopback `http://127.0.0.1/callback`
 *   (Better Auth matches a native loopback redirect on any port).
 * - `cognia-web`: the official web app. Its redirects depend on the deployment's
 *   `WEB_ORIGINS`, so they are reconciled from configuration at runtime instead
 *   of living in the migration.
 */

export const COGNIA_APP_CLIENT_ID = "cognia-app"
export const COGNIA_WEB_CLIENT_ID = "cognia-web"
export const FIRST_PARTY_CLIENT_IDS: readonly string[] = [
  COGNIA_APP_CLIENT_ID,
  COGNIA_WEB_CLIENT_ID,
]

export const NATIVE_CALLBACK_URI = "cn.cognia.app:/auth/callback"
export const LOOPBACK_CALLBACK_URI = "http://127.0.0.1/callback"

/** The web app's callback route (`app/logto/callback`), issuer-agnostic despite its name. */
export const WEB_CALLBACK_PATH = "/logto/callback"

export interface WebClientUris {
  redirectUris: string[]
  postLogoutRedirectUris: string[]
}

export function webClientUris(webOrigins: readonly string[]): WebClientUris {
  return {
    redirectUris: webOrigins.map((origin) => `${origin}${WEB_CALLBACK_PATH}`),
    postLogoutRedirectUris: webOrigins.map((origin) => `${origin}/`),
  }
}

function sameList(stored: unknown, wanted: readonly string[]): boolean {
  if (typeof stored !== "string") return false
  try {
    const parsed: unknown = JSON.parse(stored)
    return (
      Array.isArray(parsed) &&
      parsed.length === wanted.length &&
      parsed.every((value, index) => value === wanted[index])
    )
  } catch {
    return false
  }
}

let reconciledFor: string | null = null

/**
 * Point `cognia-web` at this deployment's web origins. Idempotent; the first
 * request of each isolate checks, later ones skip.
 */
export async function reconcileWebClient(
  db: D1Database,
  webOrigins: readonly string[],
  now: Date = new Date()
): Promise<"unchanged" | "updated" | "missing"> {
  const fingerprint = webOrigins.join(",")
  if (reconciledFor === fingerprint) return "unchanged"
  const wanted = webClientUris(webOrigins)
  const row = await db
    .prepare(
      'SELECT "redirectUris", "postLogoutRedirectUris" FROM "oauthClient" WHERE "clientId" = ?'
    )
    .bind(COGNIA_WEB_CLIENT_ID)
    .first<{ redirectUris: string | null; postLogoutRedirectUris: string | null }>()
  if (!row) return "missing"
  if (
    sameList(row.redirectUris, wanted.redirectUris) &&
    sameList(row.postLogoutRedirectUris, wanted.postLogoutRedirectUris)
  ) {
    reconciledFor = fingerprint
    return "unchanged"
  }
  await db
    .prepare(
      'UPDATE "oauthClient" SET "redirectUris" = ?, "postLogoutRedirectUris" = ?, "updatedAt" = ? WHERE "clientId" = ?'
    )
    .bind(
      JSON.stringify(wanted.redirectUris),
      JSON.stringify(wanted.postLogoutRedirectUris),
      now.toISOString(),
      COGNIA_WEB_CLIENT_ID
    )
    .run()
  reconciledFor = fingerprint
  return "updated"
}

/** Test seam: run the reconciliation again on the next call. */
export function resetWebClientReconciliation(): void {
  reconciledFor = null
}
