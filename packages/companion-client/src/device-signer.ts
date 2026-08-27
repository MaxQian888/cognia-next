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
 * There is deliberately no `thumbprint` on this interface. The Host binds the
 * access token to the registered key and checks it server-side
 * (`token_key_mismatch`); the proof itself carries no key material, so a
 * client-held thumbprint would be a field nothing reads. It also could not be
 * recomputed on the browser side, where the private key is non-extractable and
 * WebCrypto offers no way to derive its public half — so the field would have
 * had to be stored, and a stored copy of a derived value is a thing that can
 * disagree with what it was derived from.
 */
export interface DeviceSigner {
  deviceId: string
  /** Raw ECDSA P-256 / SHA-256 signature over `data`, in IEEE P1363 form. */
  sign(data: Uint8Array): Promise<Uint8Array>
}

/** Build a signer from a WebCrypto private key. */
export function signerFromCryptoKey(deviceId: string, privateKey: CryptoKey): DeviceSigner {
  return {
    deviceId,
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
  privateKeyJwk: JsonWebKey
): Promise<DeviceSigner> {
  const key = await crypto.subtle.importKey(
    "jwk",
    privateKeyJwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"]
  )
  return signerFromCryptoKey(deviceId, key)
}
