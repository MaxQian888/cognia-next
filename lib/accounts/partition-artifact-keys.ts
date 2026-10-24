/**
 * Artifact keys for a person partition's brain (plan §9a/§9b, P6c).
 *
 * A headless brain normally keeps account artifact keys (work submissions,
 * evaluation artifacts, …) in the Host keyring over RPC. A person brain must
 * not: the Host keyring is not partitioned, and the person brain's channel to
 * the Host admits only its tool-less chat commands. What a person brain does
 * have is its own account content key, handed over once at unlock.
 *
 * So at unlock, before that key is zeroed, it is imported here as a
 * non-extractable HKDF base. Every artifact key is then derived from it with
 * a label naming the artifact domain and the account. The derived key is
 * stable across restarts (the content key is), never leaves the process, and
 * a key for one domain or account says nothing about another.
 *
 * Only person brains install a base. The operator brain and the desktop keep
 * their keyring keys, so data they already sealed stays readable.
 */

const SALT = new TextEncoder().encode("cognia/partition-artifact-key/v1")

let installed: { accountId: string; base: CryptoKey } | null = null

function subtle(): SubtleCrypto {
  if (!globalThis.crypto?.subtle)
    throw new Error("Web Crypto is required for partition artifact keys")
  return globalThis.crypto.subtle
}

/**
 * Import the partition's content key as the HKDF base. Copies the bytes it
 * needs; the caller still owns (and zeroes) `contentKey`.
 */
export async function installPartitionArtifactKeyBase(
  accountId: string,
  contentKey: Uint8Array
): Promise<void> {
  if (!accountId) throw new Error("An account id is required for partition artifact keys")
  if (contentKey.length !== 32) throw new Error("Partition content key must be exactly 32 bytes.")
  const copy = contentKey.slice()
  try {
    const base = await subtle().importKey("raw", copy, "HKDF", false, ["deriveBits"])
    installed = { accountId, base }
  } finally {
    copy.fill(0)
  }
}

/** Whether this process derives artifact keys for `accountId` from its partition base. */
export function hasPartitionArtifactKeys(accountId: string): boolean {
  return installed?.accountId === accountId
}

/** The 256-bit artifact key for one domain of the partition's account. */
export async function derivePartitionArtifactKey(
  accountId: string,
  domain: string
): Promise<Uint8Array> {
  if (!installed || installed.accountId !== accountId) {
    throw new Error("No partition artifact key base is installed for this account")
  }
  if (!domain) throw new Error("An artifact domain is required")
  const bits = await subtle().deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: SALT,
      info: new TextEncoder().encode(`${domain}\u0000${accountId}`),
    },
    installed.base,
    256
  )
  return new Uint8Array(bits)
}

/** Forget the base (tests, and a brain that locks its account). */
export function clearPartitionArtifactKeyBase(): void {
  installed = null
}
