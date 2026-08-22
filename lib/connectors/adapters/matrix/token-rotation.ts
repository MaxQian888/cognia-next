/**
 * Keyring-backed access-token rotation for Matrix.
 *
 * A Matrix homeserver may issue expiring access tokens. Until now the login
 * flow threw the `refresh_token` away and kept only the access token, so when
 * the homeserver expired it the bot stopped with `M_UNKNOWN_TOKEN` and the only
 * way back was for a person to open settings and type their password again —
 * losing the device, and with it every end-to-end encryption key that device
 * held.
 *
 * Refreshing keeps the device. This module owns that exchange and the two
 * invariants around it:
 *
 *   1. **Both halves are written together.** Matrix rotates refresh tokens: a
 *      refresh response may carry a new one, and when it does the old one is
 *      already dead. Persisting the access token but not the refresh token
 *      leaves the bot working right up until the next expiry, then permanently
 *      stuck with a refresh token the server has forgotten.
 *   2. **One refresh at a time.** A sync loop and an outbound send can hit
 *      `M_UNKNOWN_TOKEN` in the same instant; letting both refresh would burn
 *      one of the two rotated tokens immediately. Concurrent callers share a
 *      single in-flight attempt.
 */

import { connectorsKeyringGet, connectorsKeyringSet } from "@/lib/connectors/tauri/commands"
import { refreshMatrixAccessToken, type MatrixRefreshResult } from "./auth"

/** Keyring account holding the current access token. */
export const ACCESS_TOKEN_ACCOUNT = "accessToken"
/** Keyring account holding the current refresh token, when the server issues one. */
export const REFRESH_TOKEN_ACCOUNT = "refreshToken"

export type MatrixRotationOutcome =
  | { ok: true; accessToken: string }
  /** The user must sign in again — the refresh token is dead or absent. */
  | { ok: false; needsReauth: true; error: string }
  /** Transient; the caller should keep retrying with backoff. */
  | { ok: false; needsReauth: false; error: string }

/** adapterId → in-flight refresh, so concurrent failures share one exchange. */
const inFlight = new Map<string, Promise<MatrixRotationOutcome>>()

export interface RotateDeps {
  getSecret?: typeof connectorsKeyringGet
  setSecret?: typeof connectorsKeyringSet
  refresh?: typeof refreshMatrixAccessToken
}

/**
 * Exchange the stored refresh token for a new access token and persist both.
 *
 * Returns the new access token on success. `needsReauth` distinguishes "this
 * bot is finished until a human intervenes" from "try again shortly" — the
 * caller must not push a user into re-authentication over a flaky network.
 */
export async function rotateMatrixAccessToken(
  adapterId: string,
  homeserver: string,
  deps: RotateDeps = {}
): Promise<MatrixRotationOutcome> {
  const existing = inFlight.get(adapterId)
  if (existing) return existing

  const attempt = performRotation(adapterId, homeserver, deps).finally(() => {
    inFlight.delete(adapterId)
  })
  inFlight.set(adapterId, attempt)
  return attempt
}

/**
 * Total by construction: this runs inside the sync loop's retry path, so a
 * throw here would surface as a generic transport error and the loop would
 * spin instead of either recovering or reporting that re-auth is needed.
 */
async function performRotation(
  adapterId: string,
  homeserver: string,
  deps: RotateDeps
): Promise<MatrixRotationOutcome> {
  try {
    return await rotateOnce(adapterId, homeserver, deps)
  } catch (err) {
    return {
      ok: false,
      needsReauth: false,
      error: `Matrix token rotation failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}

async function rotateOnce(
  adapterId: string,
  homeserver: string,
  deps: RotateDeps
): Promise<MatrixRotationOutcome> {
  const getSecret = deps.getSecret ?? connectorsKeyringGet
  const setSecret = deps.setSecret ?? connectorsKeyringSet
  const refresh = deps.refresh ?? refreshMatrixAccessToken

  let stored: unknown
  try {
    stored = await getSecret(adapterId, REFRESH_TOKEN_ACCOUNT)
  } catch (err) {
    return { ok: false, needsReauth: false, error: keyringError(err) }
  }
  // Anything that is not a non-empty string is "no usable refresh token" —
  // including whatever a misbehaving transport hands back.
  const refreshToken = typeof stored === "string" ? stored.trim() : ""
  if (!refreshToken) {
    // Configured with a bare access token (the "paste a token" path), so there
    // is nothing to exchange. Only a person can fix this.
    return {
      ok: false,
      needsReauth: true,
      error: "Matrix access token expired and no refresh token is stored",
    }
  }

  const result: MatrixRefreshResult = await refresh(homeserver, refreshToken)
  if (!result.ok) {
    return {
      ok: false,
      // A rejected refresh token is terminal; a network blip is not.
      needsReauth: result.reason === "rejected" || result.reason === "no_refresh_token",
      error: result.error,
    }
  }

  try {
    // Rotated refresh token FIRST: if the process dies between the two writes,
    // a stale access token is recoverable (the next refresh fixes it) whereas a
    // stale refresh token is not.
    if (result.refreshToken) {
      await setSecret(adapterId, REFRESH_TOKEN_ACCOUNT, result.refreshToken)
    }
    await setSecret(adapterId, ACCESS_TOKEN_ACCOUNT, result.accessToken)
  } catch (err) {
    return { ok: false, needsReauth: false, error: keyringError(err) }
  }

  return { ok: true, accessToken: result.accessToken }
}

function keyringError(err: unknown): string {
  return `Matrix token rotation could not reach the keyring: ${
    err instanceof Error ? err.message : String(err)
  }`
}

/** Test-only: drop any in-flight refresh so cases cannot leak into each other. */
export function __resetMatrixRotationForTesting(): void {
  inFlight.clear()
}
