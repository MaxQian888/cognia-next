/**
 * GitHub OAuth device flow for a Cognia-owned OAuth App (ADR-0235 §5).
 *
 * A third way to hold a github.com credential, beside the `gh` CLI token and
 * the stored PAT and App accounts: the user approves Cognia on github.com
 * with a short code, and the resulting token is stored by the `github-oauth`
 * provider in the same `integration-github-credentials` store
 * (`./github-auth.ts`). The bootstrap of a Host over a VS Code tunnel uses it
 * to sign in to the tunnel service on a machine with no `gh` CLI.
 *
 *   1. {@link beginGithubDeviceAuth} → `POST github.com/login/device/code`
 *   2. the user opens `verificationUri` and types `userCode`
 *   3. {@link pollGithubDeviceAuth} → `POST github.com/login/oauth/access_token`
 *      until GitHub answers with a token, a denial or an expiry
 *   4. {@link fetchGithubIdentity} reads the numeric account id the token
 *      belongs to, so an account is never matched by login alone
 *
 * **Dormant until a build names the OAuth App.** The client id is build
 * configuration, `NEXT_PUBLIC_COGNIA_GITHUB_OAUTH_CLIENT_ID`; Cognia never
 * borrows another product's client id. With it unset,
 * {@link githubDeviceFlowAvailability} answers `no-client-id`, the Devices UI
 * (ADR-0235 P5) must show the option as unavailable in this build, and every
 * call here refuses before any network request. `github-device-flow.test.ts`
 * pins all three.
 *
 * github.com only: an Enterprise Server registers its own OAuth Apps, so a
 * build-time client id cannot be valid there.
 *
 * Requests go through the native proxy bridge: github.com/login serves no CORS
 * headers, so a plain browser `fetch` cannot read its answers. The device and
 * access tokens never reach a log line or an error message.
 */

import { GITHUB_DOT_COM } from "@/lib/github/host"
import { proxyFetch } from "@/lib/network/proxy-fetch"
import { reachesNonCorsHosts } from "@/lib/network/platform-fetch"

export const GITHUB_DEVICE_CODE_URL = `${GITHUB_DOT_COM.webBaseUrl}/login/device/code`
export const GITHUB_ACCESS_TOKEN_URL = `${GITHUB_DOT_COM.webBaseUrl}/login/oauth/access_token`
const DEVICE_GRANT = "urn:ietf:params:oauth:grant-type:device_code"
/** GitHub's documented minimum, and its default when `interval` is absent. */
const MIN_INTERVAL_SECONDS = 5
/** RFC 8628 §3.5: a `slow_down` adds five seconds to the interval. */
const SLOW_DOWN_STEP_SECONDS = 5
const REQUEST_TIMEOUT_MS = 30_000

/** The build's OAuth App client id, or `undefined` when the build names none. */
export function githubOAuthClientId(
  // Next inlines only literal `process.env.NEXT_PUBLIC_*` reads.
  raw: string | undefined = process.env.NEXT_PUBLIC_COGNIA_GITHUB_OAUTH_CLIENT_ID
): string | undefined {
  const value = raw?.trim()
  // OAuth App client ids are `Iv1.`/`Ov23…` style tokens; anything with
  // whitespace or URL syntax is a misconfigured build, not a client id.
  return value && /^[A-Za-z0-9._-]{8,64}$/.test(value) ? value : undefined
}

/** Whether this build and shell can run the device flow, and if not, why. */
export type GithubDeviceFlowAvailability =
  | { available: true; clientId: string }
  | { available: false; reason: "no-client-id" | "no-native-network" }

export function githubDeviceFlowAvailability(
  deps: { clientId?: string | undefined; reachesNonCorsHosts?: () => boolean } = {}
): GithubDeviceFlowAvailability {
  const clientId = "clientId" in deps ? githubOAuthClientId(deps.clientId) : githubOAuthClientId()
  if (!clientId) return { available: false, reason: "no-client-id" }
  if (!(deps.reachesNonCorsHosts ?? reachesNonCorsHosts)()) {
    return { available: false, reason: "no-native-network" }
  }
  return { available: true, clientId }
}

export interface GithubDeviceAuthChallenge {
  deviceCode: string
  userCode: string
  verificationUri: string
  intervalSeconds: number
  /** Epoch ms after which the code is dead. */
  expiresAt: number
  /** The scopes asked for, space-joined the way GitHub reads them. */
  scope: string
}

/** The challenge without the device code, safe to show or log. */
export function publicChallenge(
  challenge: GithubDeviceAuthChallenge
): Omit<GithubDeviceAuthChallenge, "deviceCode"> {
  const { deviceCode: _secret, ...rest } = challenge
  return rest
}

export type GithubDeviceAuthPoll =
  | { status: "pending" }
  | { status: "slow_down"; intervalSeconds: number }
  | { status: "authorized"; accessToken: string; scopes: string[] }
  | { status: "denied" }
  | { status: "expired" }
  | { status: "error"; code: string }

export interface GithubDeviceFlowDeps {
  fetch?: typeof fetch
  now?: () => number
  /** Overrides the build's client id; tests and the availability check. */
  clientId?: string
}

/** Thrown when the flow cannot start or a response is unusable. */
export class GithubDeviceFlowError extends Error {
  constructor(
    readonly code:
      | "no-client-id"
      | "http"
      | "malformed"
      | "device-flow-disabled"
      | "incorrect-client-credentials",
    message: string
  ) {
    super(message)
    this.name = "GithubDeviceFlowError"
  }
}

function requireClientId(deps: GithubDeviceFlowDeps): string {
  const clientId = "clientId" in deps ? githubOAuthClientId(deps.clientId) : githubOAuthClientId()
  if (!clientId) {
    throw new GithubDeviceFlowError(
      "no-client-id",
      "This build has no GitHub OAuth App; sign in with the GitHub CLI or a stored account instead."
    )
  }
  return clientId
}

function form(body: Record<string, string>): string {
  return new URLSearchParams(body).toString()
}

async function post(
  deps: GithubDeviceFlowDeps,
  url: string,
  body: Record<string, string>
): Promise<{ status: number; json: Record<string, unknown> | null }> {
  const response = await (deps.fetch ?? proxyFetch)(url, {
    method: "POST",
    headers: {
      accept: "application/json",
      "content-type": "application/x-www-form-urlencoded",
    },
    body: form(body),
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  let json: Record<string, unknown> | null = null
  try {
    const parsed: unknown = await response.json()
    json = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null
  } catch {
    json = null
  }
  return { status: response.status, json }
}

function positiveSeconds(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback
}

/** Step 1: ask GitHub for a device and user code. */
export async function beginGithubDeviceAuth(
  scopes: readonly string[],
  deps: GithubDeviceFlowDeps = {}
): Promise<GithubDeviceAuthChallenge> {
  const clientId = requireClientId(deps)
  const now = deps.now ?? Date.now
  const scope = [...new Set(scopes.map((value) => value.trim()).filter(Boolean))].join(" ")
  const { status, json } = await post(deps, GITHUB_DEVICE_CODE_URL, {
    client_id: clientId,
    scope,
  })
  if (json?.error === "device_flow_disabled") {
    throw new GithubDeviceFlowError(
      "device-flow-disabled",
      "Device flow is not enabled for this build's GitHub OAuth App."
    )
  }
  if (json?.error === "incorrect_client_credentials") {
    throw new GithubDeviceFlowError(
      "incorrect-client-credentials",
      "GitHub does not recognise this build's OAuth App client id."
    )
  }
  if (status !== 200) {
    throw new GithubDeviceFlowError("http", `GitHub answered HTTP ${status}`)
  }
  const deviceCode = json?.device_code
  const userCode = json?.user_code
  const verificationUri = json?.verification_uri
  if (
    typeof deviceCode !== "string" ||
    !deviceCode ||
    typeof userCode !== "string" ||
    !/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(userCode) ||
    typeof verificationUri !== "string" ||
    !verificationUri.startsWith(`${GITHUB_DOT_COM.webBaseUrl}/`)
  ) {
    throw new GithubDeviceFlowError("malformed", "GitHub's device code answer was incomplete")
  }
  return {
    deviceCode,
    userCode,
    verificationUri,
    intervalSeconds: Math.max(
      MIN_INTERVAL_SECONDS,
      positiveSeconds(json?.interval, MIN_INTERVAL_SECONDS)
    ),
    expiresAt: now() + positiveSeconds(json?.expires_in, 900) * 1000,
    scope,
  }
}

/** Step 3: one poll of the token endpoint. Never throws for an OAuth error. */
export async function pollGithubDeviceAuth(
  challenge: Pick<GithubDeviceAuthChallenge, "deviceCode" | "expiresAt" | "intervalSeconds">,
  deps: GithubDeviceFlowDeps = {}
): Promise<GithubDeviceAuthPoll> {
  const clientId = requireClientId(deps)
  const now = deps.now ?? Date.now
  if (now() >= challenge.expiresAt) return { status: "expired" }
  const { status, json } = await post(deps, GITHUB_ACCESS_TOKEN_URL, {
    client_id: clientId,
    device_code: challenge.deviceCode,
    grant_type: DEVICE_GRANT,
  })
  const error = json?.error
  if (typeof error === "string") {
    switch (error) {
      case "authorization_pending":
        return { status: "pending" }
      case "slow_down":
        return {
          status: "slow_down",
          intervalSeconds: positiveSeconds(
            json?.interval,
            challenge.intervalSeconds + SLOW_DOWN_STEP_SECONDS
          ),
        }
      case "access_denied":
        return { status: "denied" }
      case "expired_token":
        return { status: "expired" }
      default:
        // `incorrect_device_code`, `unsupported_grant_type`,
        // `device_flow_disabled`, …: GitHub's code only, never its prose.
        return { status: "error", code: error }
    }
  }
  const accessToken = json?.access_token
  if (status !== 200 || typeof accessToken !== "string" || !accessToken) {
    return { status: "error", code: `http_${status}` }
  }
  const scope = typeof json?.scope === "string" ? json.scope : ""
  return {
    status: "authorized",
    accessToken,
    scopes: scope
      .split(/[,\s]+/)
      .map((value) => value.trim())
      .filter(Boolean),
  }
}

/** The account a token belongs to: GitHub's numeric id, and the login. */
export interface GithubIdentity {
  id: number
  login: string
}

/** Step 4: `GET /user`. A login without a positive integer id is refused. */
export async function fetchGithubIdentity(
  accessToken: string,
  deps: Pick<GithubDeviceFlowDeps, "fetch"> = {}
): Promise<GithubIdentity> {
  const response = await (deps.fetch ?? proxyFetch)(`${GITHUB_DOT_COM.apiBaseUrl}/user`, {
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${accessToken}`,
      "x-github-api-version": "2022-11-28",
    },
    redirect: "error",
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  })
  if (!response.ok) {
    throw new GithubDeviceFlowError("http", `GitHub answered HTTP ${response.status} for /user`)
  }
  const user = (await response.json().catch(() => null)) as { id?: unknown; login?: unknown } | null
  if (
    typeof user?.id !== "number" ||
    !Number.isSafeInteger(user.id) ||
    user.id < 1 ||
    typeof user.login !== "string" ||
    !/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(user.login)
  ) {
    throw new GithubDeviceFlowError("malformed", "GitHub's /user answer had no account id")
  }
  return { id: user.id, login: user.login }
}
