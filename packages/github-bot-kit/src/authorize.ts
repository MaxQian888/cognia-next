/**
 * Who may command a Bot from a GitHub comment.
 *
 * Checked against GitHub itself on every decision, not against anything the
 * comment or a stored record claims: a person who loses write access, or
 * leaves the allowlist, stops being able to command the Bot at the next
 * check. Callers run this outside memoised steps for exactly that reason.
 *
 * Order (cheapest refusal first, and no API call for a refusal the
 * installation already knows):
 *
 *  1. machine accounts are refused;
 *  2. the author's numeric id must be on the installation's allowlist (ids,
 *     never logins: a login can be renamed and re-registered);
 *  3. `GET /collaborators/{login}/permission` must name the SAME user id and
 *     grant at least write. `author_association`, display names and org
 *     membership are not consulted.
 *
 * A failure to ask (rate limit, outage, a token GitHub refuses) is
 * `unavailable`, never `denied`: it says nothing about the author, and the
 * caller backs off or reports setup instead of telling them they lack access.
 */

import { GithubRequestError, type GithubReader } from "./reader"
import { isBotUser } from "./review-threads"

export interface CommandAuthor {
  id: number
  login: string
  type?: string
}

export type CommandAuthorDecision =
  | { outcome: "allowed"; permission: "admin" | "maintain" | "write" }
  | {
      outcome: "denied"
      reason:
        | "bot_author"
        | "not_allowlisted"
        | "not_collaborator"
        | "insufficient_permission"
        | "identity_mismatch"
        | "unknown_permission"
    }
  | {
      outcome: "unavailable"
      reason: "rate_limited" | "credential_rejected" | "transient"
      retryAt?: number
    }

const WRITE_PERMISSIONS = new Set(["admin", "maintain", "write"])
const BELOW_WRITE = new Set(["triage", "read", "none"])
const GITHUB_LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/

interface PermissionResponse {
  permission?: string
  role_name?: string
  user?: { id?: number; login?: string } | null
}

export async function checkCommandAuthor(
  reader: Pick<GithubReader, "request">,
  author: CommandAuthor,
  allowlist: readonly (string | number)[]
): Promise<CommandAuthorDecision> {
  if (isBotUser(author)) return { outcome: "denied", reason: "bot_author" }
  if (!Number.isSafeInteger(author.id) || author.id < 1 || !GITHUB_LOGIN.test(author.login)) {
    return { outcome: "denied", reason: "identity_mismatch" }
  }
  if (!allowlist.some((entry) => String(entry) === String(author.id))) {
    return { outcome: "denied", reason: "not_allowlisted" }
  }
  let data: PermissionResponse
  try {
    data = (
      await reader.request<PermissionResponse>(
        `/collaborators/${encodeURIComponent(author.login)}/permission`
      )
    ).data
  } catch (error) {
    if (!(error instanceof GithubRequestError)) {
      return { outcome: "unavailable", reason: "transient" }
    }
    if (error.rateLimited) {
      return { outcome: "unavailable", reason: "rate_limited", retryAt: error.retryAt }
    }
    if (error.status === 404) return { outcome: "denied", reason: "not_collaborator" }
    if (error.status === 401 || error.status === 403) {
      return { outcome: "unavailable", reason: "credential_rejected" }
    }
    return { outcome: "unavailable", reason: "transient", retryAt: error.retryAt }
  }
  // A rename between the event and this check must not let the new holder of
  // the login inherit the old one's command.
  if (data?.user?.id !== author.id) return { outcome: "denied", reason: "identity_mismatch" }
  // `role_name` carries `maintain` (the base `permission` reports it as write);
  // a custom role reports its base in `permission`.
  const role = data.role_name?.toLowerCase()
  const base = data.permission?.toLowerCase()
  if (role === "maintain" && base === "write") return { outcome: "allowed", permission: "maintain" }
  if (base && WRITE_PERMISSIONS.has(base)) {
    return { outcome: "allowed", permission: base as "admin" | "maintain" | "write" }
  }
  if (base && BELOW_WRITE.has(base)) return { outcome: "denied", reason: "insufficient_permission" }
  return { outcome: "denied", reason: "unknown_permission" }
}
