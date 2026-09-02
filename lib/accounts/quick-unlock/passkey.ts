/**
 * Passkey unlock, via the WebAuthn `prf` extension.
 *
 * WHY PRF SPECIFICALLY
 *
 * An ordinary WebAuthn assertion proves that an authenticator was present. It
 * does not produce a stable secret, and the signature it returns is different
 * every time because it covers a fresh challenge. That is exactly right for
 * signing in to a server and completely useless for opening a local vault,
 * which needs the SAME bytes back on every unlock.
 *
 * The `prf` extension is what closes that gap: the authenticator evaluates a
 * PRF over an input the relying party supplies and returns 32 bytes that are
 * stable for that credential and that input. Those bytes have full entropy, so
 * unlike a PIN or a pattern they need no device pepper and no attempt cap to
 * be safe.
 *
 * WHY THE CAPABILITY CHECK IS NOT OPTIONAL
 *
 * PRF is not available everywhere, and the failure mode is quiet: an
 * authenticator that does not implement it still completes registration
 * happily and simply omits the extension results. Falling back to a plain
 * assertion at that point would be worse than useless, because a plain
 * assertion cannot produce a key and pretending otherwise would mean enrolling
 * a method that can never unlock anything.
 *
 * So enrollment REQUIRES a proven PRF response and refuses otherwise, and the
 * UI hides passkey entirely where {@link isPasskeySupported} is false rather
 * than offering a button that leads nowhere.
 */

/** The relying-party id. Derived from the origin, never hardcoded. */
function relyingPartyId(): string {
  if (typeof window === "undefined") return "localhost"
  return window.location.hostname || "localhost"
}

/**
 * Fixed PRF input.
 *
 * A constant, by design: the secrecy lives in the authenticator, and a stable
 * input is what makes the derived bytes stable across unlocks. Salted per
 * account so two accounts on one authenticator derive different secrets.
 */
function prfInput(accountId: string): Uint8Array {
  return new TextEncoder().encode(`cognia.quick-unlock.passkey.v1:${accountId}`)
}

export interface PasskeyEnrollment {
  /** Base64url credential id, needed to request the same credential later. */
  credentialId: string
  /** Human-readable authenticator label where one is offered. */
  label?: string
  createdAt: number
}

/** Why a passkey operation could not complete. */
export type PasskeyFailure = "unsupported" | "no-prf" | "cancelled" | "no-credential" | "failed"

export type PasskeyResult<T> = { ok: true; value: T } | { ok: false; reason: PasskeyFailure }

/**
 * Whether this runtime can do passkey unlock AT ALL.
 *
 * Deliberately coarse. It answers "is the API present", which is the only
 * thing that can be known without prompting the user. Whether the specific
 * authenticator implements PRF is discovered during enrollment, which is why
 * enrollment has its own `no-prf` outcome.
 */
export function isPasskeySupported(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.PublicKeyCredential === "function" &&
    typeof navigator !== "undefined" &&
    typeof navigator.credentials?.create === "function" &&
    typeof navigator.credentials?.get === "function" &&
    // A secure context is a hard WebAuthn requirement. Saying so up front is
    // better than a rejected promise the user reads as a broken feature.
    window.isSecureContext === true
  )
}

/**
 * Whether a platform authenticator (Touch ID, Windows Hello, the phone's own
 * biometrics) is actually available, as opposed to only a roaming key.
 *
 * Used to phrase the offer accurately rather than to gate it: a security key
 * is a perfectly good passkey.
 */
export async function hasPlatformAuthenticator(): Promise<boolean> {
  if (!isPasskeySupported()) return false
  try {
    return await window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()
  } catch {
    return false
  }
}

interface PrfExtensionResults {
  prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } }
}

/**
 * Register a new passkey and prove it can produce PRF output.
 *
 * Returns `no-prf` when the authenticator completed registration but did not
 * report PRF support. The credential is left in place rather than deleted,
 * because WebAuthn offers no way to delete one, but it is not recorded, so
 * nothing in the app will ever reference it.
 */
export async function enrollPasskey(args: {
  accountId: string
  displayName: string
  now?: number
}): Promise<PasskeyResult<{ enrollment: PasskeyEnrollment; secret: Uint8Array }>> {
  if (!isPasskeySupported()) return { ok: false, reason: "unsupported" }
  const now = args.now ?? Date.now()

  const challenge = randomBytes(32)
  const userId = new TextEncoder().encode(args.accountId)

  let credential: PublicKeyCredential | null
  try {
    credential = (await navigator.credentials.create({
      publicKey: {
        challenge: toBuffer(challenge),
        rp: { id: relyingPartyId(), name: "Cognia" },
        user: {
          id: toBuffer(userId),
          name: args.displayName,
          displayName: args.displayName,
        },
        // ES256 then RS256, the two every authenticator implements.
        pubKeyCredParams: [
          { type: "public-key", alg: -7 },
          { type: "public-key", alg: -257 },
        ],
        authenticatorSelection: {
          residentKey: "preferred",
          userVerification: "required",
        },
        timeout: 60_000,
        extensions: {
          prf: { eval: { first: toBuffer(prfInput(args.accountId)) } },
        } as AuthenticationExtensionsClientInputs,
      },
    })) as PublicKeyCredential | null
  } catch (error) {
    return { ok: false, reason: isAbort(error) ? "cancelled" : "failed" }
  }

  if (!credential) return { ok: false, reason: "no-credential" }

  const extensions = credential.getClientExtensionResults() as PrfExtensionResults
  // `enabled` says the authenticator supports PRF. Some report support at
  // creation without returning results until the first assertion, so a missing
  // `results` here is not itself a failure.
  if (!extensions.prf?.enabled) return { ok: false, reason: "no-prf" }

  const enrollment: PasskeyEnrollment = {
    credentialId: encodeBase64Url(new Uint8Array(credential.rawId)),
    createdAt: now,
  }

  const first = extensions.prf.results?.first
  if (first) {
    return { ok: true, value: { enrollment, secret: new Uint8Array(first) } }
  }

  // No results at creation time. Ask for an assertion immediately so
  // enrollment still completes in one user-visible step.
  const asserted = await derivePasskeySecret({
    accountId: args.accountId,
    credentialId: enrollment.credentialId,
  })
  if (!asserted.ok) return asserted
  return { ok: true, value: { enrollment, secret: asserted.value } }
}

/**
 * Ask the authenticator for this credential's PRF output.
 *
 * The returned bytes are the unlock secret. Full entropy, so unlike a PIN they
 * are used directly with no pepper.
 */
export async function derivePasskeySecret(args: {
  accountId: string
  credentialId: string
}): Promise<PasskeyResult<Uint8Array>> {
  if (!isPasskeySupported()) return { ok: false, reason: "unsupported" }

  const challenge = randomBytes(32)
  let assertion: PublicKeyCredential | null
  try {
    assertion = (await navigator.credentials.get({
      publicKey: {
        challenge: toBuffer(challenge),
        rpId: relyingPartyId(),
        allowCredentials: [
          { type: "public-key", id: toBuffer(decodeBase64Url(args.credentialId)) },
        ],
        userVerification: "required",
        timeout: 60_000,
        extensions: {
          prf: { eval: { first: toBuffer(prfInput(args.accountId)) } },
        } as AuthenticationExtensionsClientInputs,
      },
    })) as PublicKeyCredential | null
  } catch (error) {
    return { ok: false, reason: isAbort(error) ? "cancelled" : "failed" }
  }

  if (!assertion) return { ok: false, reason: "no-credential" }

  const extensions = assertion.getClientExtensionResults() as PrfExtensionResults
  const first = extensions.prf?.results?.first
  if (!first) return { ok: false, reason: "no-prf" }
  return { ok: true, value: new Uint8Array(first) }
}

/** The canonical secret string a PRF output becomes for the vault wrap. */
export function canonicalizePasskeySecret(secret: Uint8Array): string {
  return `passkey:${encodeBase64Url(secret)}`
}

function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === "NotAllowedError" || error.name === "AbortError")
}

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length)
  globalThis.crypto.getRandomValues(bytes)
  return bytes
}

function toBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

export function encodeBase64Url(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

export function decodeBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/")
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="))
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
  return bytes
}
