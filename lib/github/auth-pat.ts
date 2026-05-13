/**
 * Personal Access Token (PAT) authentication helper.
 *
 * Wraps `@octokit/auth-token`'s strategy for use with `@octokit/core`. PAT is
 * the kickstart credential mode (D5 in the plan) — simpler than the App flow
 * but limited to whoever owns the token.
 */

import { Octokit } from "@octokit/core"
import { createTokenAuth } from "@octokit/auth-token"

export interface PatAuthOptions {
  token: string
  /** Optional UA suffix; appended after the default cognia UA. */
  userAgent?: string
}

const COGNIA_UA = "cognia-github-delivery/1.0"

/**
 * Build an Octokit instance authenticated with a PAT.
 *
 * Throws synchronously on empty token rather than producing an octokit that
 * fails on every request — easier to surface during setup-wizard validation.
 */
export function withPatAuth(opts: PatAuthOptions): Octokit {
  if (!opts.token) {
    throw new Error("PAT token must not be empty")
  }
  return new Octokit({
    auth: opts.token,
    authStrategy: createTokenAuth,
    userAgent: opts.userAgent ? `${COGNIA_UA} ${opts.userAgent}` : COGNIA_UA,
  })
}
