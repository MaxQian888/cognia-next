/**
 * Cloudflare Access credentials for the operator API.
 *
 * The CLI obtains the operator's Access JWT and sends it in the
 * `cf-access-token` request header. That is the header Cloudflare Access
 * accepts from non-browser clients at the edge (the same one
 * `cloudflared access curl` uses); the edge validates it and forwards the
 * identity to the Worker as `Cf-Access-Jwt-Assertion`, which the Worker
 * verifies again on its own (signature, issuer, audience, expiry and the
 * operator allowlist). The CLI never sends `Cf-Access-Jwt-Assertion`
 * itself: that header is the edge's to set.
 *
 * Sources, in order:
 * 1. `CF_ACCESS_TOKEN` (e.g. from `cloudflared access token -app=…` in a
 *    script, or a CI secret for a specific operator identity);
 * 2. `cloudflared access token -app=<API origin>`, when `cloudflared` is
 *    installed and the operator ran `cloudflared access login <API origin>`.
 * The token is never printed or logged.
 */

export const ACCESS_TOKEN_HEADER = "cf-access-token"

export type CommandRunner = (
  command: string,
  args: readonly string[]
) => Promise<{ code: number; stdout: string; stderr: string }>

export class AuthError extends Error {
  override name = "AuthError"
}

const JWT_SHAPE = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/

export function accessAppUrl(apiBase: string): string {
  return new URL(apiBase).origin
}

export async function resolveAccessToken(input: {
  env: Readonly<Record<string, string | undefined>>
  apiBase: string
  run: CommandRunner
}): Promise<string> {
  const fromEnv = input.env.CF_ACCESS_TOKEN?.trim()
  if (fromEnv) {
    if (!JWT_SHAPE.test(fromEnv)) throw new AuthError("CF_ACCESS_TOKEN is not a JWT")
    return fromEnv
  }
  const app = accessAppUrl(input.apiBase)
  let result: { code: number; stdout: string; stderr: string }
  try {
    result = await input.run("cloudflared", ["access", "token", `-app=${app}`])
  } catch {
    throw new AuthError(
      `No Access token: set CF_ACCESS_TOKEN, or install cloudflared and run \`cloudflared access login ${app}\`.`
    )
  }
  const token = result.stdout.trim().split(/\s+/).pop() ?? ""
  if (result.code !== 0 || !JWT_SHAPE.test(token)) {
    throw new AuthError(
      `cloudflared could not provide a token; run \`cloudflared access login ${app}\` first.`
    )
  }
  return token
}
