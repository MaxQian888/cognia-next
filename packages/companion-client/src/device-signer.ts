/**
 * What this package needs from a device identity: the ability to sign, and the
 * two ids the Host looks the key up by.
 *
 * An interface rather than a `JsonWebKey`, because the two clients store the
 * key in incompatible ways and only one of them *can* produce a JWK. The app
 * persists an extractable JWK (into the Browser Vault, or the OS keyring); a
 * browser extension has no vault, so it generates the key, exports the public
 * half once for registration, re-imports the private half as **non-extractable**
 * and keeps only that `CryptoKey` in IndexedDB. There is no JWK left to hand
 * over afterwards, by design — the key cannot be read back out of the
 * extension even by the extension.
 *
 * `thumbprint` is `hex(SHA-256(publicKeyPem))` — a hash of the PEM *text*, not
 * an RFC 7638 JWK thumbprint. That is what the Rust side computes, and the two
 * must agree or every request fails `token_key_mismatch`.
 */
export interface DeviceSigner {
  deviceId: string
  /** `hex(SHA-256(publicKeyPem))`. */
  thumbprint: string
  /** Raw ECDSA P-256 / SHA-256 signature over `data`, in IEEE P1363 form. */
  sign(data: Uint8Array): Promise<Uint8Array>
}

/** Build a signer from a WebCrypto private key. */
export function signerFromCryptoKey(
  deviceId: string,
  thumbprint: string,
  privateKey: CryptoKey
): DeviceSigner {
  return {
    deviceId,
    thumbprint,
    async sign(data) {
      const signature = await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        privateKey,
        // A fresh copy: `subtle.sign` wants an ArrayBuffer, and a subarray view
        // would otherwise sign the whole backing buffer.
        data.slice().buffer as ArrayBuffer
      )
      return new Uint8Array(signature)
    },
  }
}

/**
 * Build a signer from a stored JWK.
 *
 * The key is imported **non-extractable** even though the JWK it came from is
 * plainly readable: it costs nothing, and it means the imported handle cannot
 * become a second copy of the secret somewhere else in the process.
 */
export async function signerFromJwk(
  deviceId: string,
  thumbprint: string,
  privateKeyJwk: JsonWebKey
): Promise<DeviceSigner> {
  const key = await crypto.subtle.importKey(
    "jwk",
    privateKeyJwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  )
  return signerFromCryptoKey(deviceId, thumbprint, key)
}
