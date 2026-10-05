/** Hashing and signing of registry entries (protocol §2, §4). */

import { toBase64Url } from "../bytes"
import { ecdsaSign, labelledHash } from "../crypto"
import { canonicalJsonBytes } from "../jcs"
import { labelled } from "../labels"
import type { EntrySignature, EntrySigner, RegistryEntry } from "./types"

/**
 * `entryHash`: over the entry without its signatures. An ECDSA signature can
 * be rewritten as `(r, n−s)` without the key, so it must never feed a hash.
 */
export async function entryHash(entry: RegistryEntry): Promise<string> {
  return toBase64Url(await labelledHash("entry-hash", canonicalJsonBytes(entry)))
}

/** The bytes every signature over an entry covers. */
export function entrySigningBytes(entry: RegistryEntry): Uint8Array {
  return labelled("entry", canonicalJsonBytes(entry))
}

export async function signEntry(
  entry: RegistryEntry,
  signer: EntrySigner,
  privateKey: CryptoKey
): Promise<EntrySignature> {
  return { signer, sig: toBase64Url(await ecdsaSign(privateKey, entrySigningBytes(entry))) }
}
