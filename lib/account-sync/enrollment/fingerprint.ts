/**
 * The device list's fingerprint (protocol §4.2): what a person compares
 * between two devices to see that the server shows both the same list. It is
 * the head hash, shortened to 80 bits and grouped like the recovery key.
 */

import { crockfordEncode, fromBase64Url, type RegistryState } from "@cognia/sync-protocol"

export function registryFingerprint(state: Pick<RegistryState, "head">): string {
  const bytes = fromBase64Url(state.head.hash).subarray(0, 10)
  return crockfordEncode(bytes)
    .match(/.{1,4}/g)!
    .join(" ")
}
