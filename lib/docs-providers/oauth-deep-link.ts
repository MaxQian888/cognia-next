/**
 * `cognia://docs-provider/oauth/<providerId>` deep-link handling (ADR-0134).
 *
 * The Rust loopback route (`/oauth/docs/<provider>/callback`) bounces Google's
 * redirect into this scheme. Parsing and completion live here, outside React,
 * so the whole exchange is unit-testable and the deep-link router component
 * stays a subscription shell.
 *
 * State validation is deliberately NOT done here: each provider validates
 * `state` against its own durable pending record (Google:
 * `providers/google/oauth-pending.ts`), which is the check that survives an app
 * restart. The connector router's `sessionStorage` state store is a different
 * mechanism for a different subsystem and must not be shared.
 */

export const DOCS_OAUTH_PATH_RE = /^cognia:\/\/docs-provider\/oauth\/([^?#/]+)/

export interface DocsOAuthCallback {
  providerId: string
  code?: string
  state?: string
  error?: string
  errorDescription?: string
}

/** Completes one provider's authorization-code exchange. Throws on failure. */
export type DocsOAuthCompletion = (callback: DocsOAuthCallback) => Promise<void>

const completions = new Map<string, DocsOAuthCompletion>()

export function registerDocsOAuthCompletion(
  providerId: string,
  completion: DocsOAuthCompletion
): void {
  if (completions.has(providerId)) {
    throw new Error(`docs OAuth completion for "${providerId}" already registered`)
  }
  completions.set(providerId, completion)
}

export function getDocsOAuthCompletion(providerId: string): DocsOAuthCompletion | undefined {
  return completions.get(providerId)
}

/** Test-only. */
export function __clearDocsOAuthCompletionsForTests(): void {
  completions.clear()
}

/** True when `raw` is a document-provider OAuth deep link. */
export function isDocsOAuthDeepLink(raw: string): boolean {
  return DOCS_OAUTH_PATH_RE.test(raw)
}

/**
 * Parse the deep link. Returns `null` when it is not ours, so a caller can fall
 * through to the connector router without special-casing.
 */
export function parseDocsOAuthDeepLink(raw: string): DocsOAuthCallback | null {
  const match = DOCS_OAUTH_PATH_RE.exec(raw)
  if (!match) return null
  let url: URL
  try {
    // The URL constructor needs an http base before it will parse a query.
    url = new URL(raw.replace(/^cognia:\/\//, "https://cognia-placeholder/"))
  } catch {
    return null
  }
  const pick = (key: string) => url.searchParams.get(key) ?? undefined
  return {
    providerId: match[1],
    code: pick("code"),
    state: pick("state"),
    error: pick("error"),
    errorDescription: pick("error_description"),
  }
}

export type DocsOAuthOutcome =
  | { status: "ignored" }
  | { status: "unknown-provider"; providerId: string }
  | { status: "ok"; providerId: string }
  | { status: "failed"; providerId: string; reason: string }

/**
 * Run the exchange for a deep link. Never throws — the caller renders the
 * outcome, and a failed OAuth must not take the app down.
 */
export async function completeDocsOAuthDeepLink(raw: string): Promise<DocsOAuthOutcome> {
  const parsed = parseDocsOAuthDeepLink(raw)
  if (!parsed) return { status: "ignored" }
  const completion = completions.get(parsed.providerId)
  if (!completion) return { status: "unknown-provider", providerId: parsed.providerId }
  try {
    await completion(parsed)
    return { status: "ok", providerId: parsed.providerId }
  } catch (err) {
    return {
      status: "failed",
      providerId: parsed.providerId,
      reason: err instanceof Error ? err.message : String(err),
    }
  }
}
