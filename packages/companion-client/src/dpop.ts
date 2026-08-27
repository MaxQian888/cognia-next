/**
 * The Cognia device proof.
 *
 * This is DPoP-shaped but it is **not** RFC 9449, and a stock library will not
 * interoperate. Two deliberate divergences, both mirrored in
 * `src-tauri/src/companion_api/api.rs::verify_device_proof`:
 *
 *  1. **No `jwk` in the header.** RFC 9449 carries the public key in the proof
 *     so a resource server can verify a token it has never seen. Cognia's Host
 *     registered the key itself and looks it up by `deviceId`, so shipping it
 *     on every request would add bytes and a second, disagreeing source of
 *     truth for which key is current.
 *  2. **`htu` is a bare path**, e.g. `/api/auth/token`, not an absolute URI.
 *     The Host is reachable on several base URLs at once — HTTPS on LAN, a
 *     tunnel, plaintext loopback — and binding the proof to whichever one the
 *     client happened to use would make a proof minted for one plane invalid
 *     on another for no security gain: the plane is already authenticated.
 *
 * `nonce` is dual-purpose, which is the part most easily got wrong: before a
 * token exists it is the challenge nonce, and afterwards it is the access
 * token's `jti`. That is what binds a proof to one token rather than to the
 * device in general.
 */
import { bytesToBase64Url, textToBase64Url } from "./base64url"
import type { DeviceSigner } from "./device-signer"

/** Lifetime of one proof. Matches the Host's `PROOF_CLOCK_SKEW_SECS` leeway. */
const PROOF_TTL_SECS = 60

export interface DeviceProofInput {
  signer: DeviceSigner
  /** Challenge nonce before a token exists; the access token's `jti` after. */
  nonce: string
  method: string
  /** Bare request path, e.g. `/api/_rpc/browser_context_submit`. */
  path: string
  /** Injectable for tests; seconds since the epoch by default. */
  nowSeconds?: number
}

export async function createDeviceProof({
  signer,
  nonce,
  method,
  path,
  nowSeconds = Math.floor(Date.now() / 1_000),
}: DeviceProofInput): Promise<string> {
  const header = textToBase64Url(JSON.stringify({ alg: "ES256", typ: "dpop+jwt" }))
  const payload = textToBase64Url(
    JSON.stringify({
      nonce,
      htm: method.toUpperCase(),
      htu: path,
      iat: nowSeconds,
      exp: nowSeconds + PROOF_TTL_SECS,
      jti: crypto.randomUUID(),
    })
  )
  const input = `${header}.${payload}`
  const signature = await signer.sign(new TextEncoder().encode(input))
  return `${input}.${bytesToBase64Url(signature)}`
}
