/**
 * Content protection for the fusion database.
 *
 * An account database encrypts its content at rest with the account content
 * cipher; the fusion database must not become the plaintext copy of the same
 * answers. Content fields are sealed with a cipher bound to the FUSION database
 * name (so an envelope cannot be replayed into another database), created from
 * the unlocked Browser Vault for every operation — never cached, so locking the
 * vault stops decryption immediately.
 *
 * A database that is not account-scoped (the legacy single database, tests)
 * stores plaintext, exactly as the main database does for the same name.
 *
 * Encryption awaits WebCrypto, which would commit an open IndexedDB transaction:
 * callers seal BEFORE opening a transaction and open AFTER it has committed.
 */

import type {
  AccountContentCipherContract,
  EncryptedContentEnvelope,
} from "@/lib/accounts/content-cipher"
import { getActiveBrowserVault } from "@/lib/runtime/browser-vault"

import { RouterFusionInfrastructureError } from "../gate/faults"

export const FUSION_CONTENT_SCHEMA_VERSION = 1
const ACCOUNT_DB_PREFIX = "cognia-account-"

export interface SealedContent {
  content: string | null
  encryptedContent: EncryptedContentEnvelope | null
}

export interface FusionContentCodec {
  readonly encrypted: boolean
  seal(table: string, primaryKey: string, field: string, value: string): Promise<SealedContent>
  open(table: string, primaryKey: string, field: string, sealed: SealedContent): Promise<string>
}

export interface ContentCodecDeps {
  /** The cipher for `databaseName`, or null when the vault is locked / another account's. */
  cipherFor(databaseName: string): AccountContentCipherContract | null
}

const defaultDeps: ContentCodecDeps = {
  cipherFor(databaseName) {
    const vault = getActiveBrowserVault()
    if (!vault || !vault.isUnlocked()) return null
    if (!databaseName.startsWith(`${ACCOUNT_DB_PREFIX}${vault.accountId}`)) return null
    return vault.createContentCipher(databaseName)
  },
}

export function fusionContentCodec(
  fusionDatabaseName: string,
  deps: ContentCodecDeps = defaultDeps
): FusionContentCodec {
  const encrypted = fusionDatabaseName.startsWith(ACCOUNT_DB_PREFIX)
  const cipher = (): AccountContentCipherContract => {
    let resolved: AccountContentCipherContract | null
    try {
      resolved = deps.cipherFor(fusionDatabaseName)
    } catch (error) {
      throw new RouterFusionInfrastructureError(
        "cipher_locked",
        "The account content cipher is unavailable.",
        error
      )
    }
    if (!resolved) {
      throw new RouterFusionInfrastructureError(
        "cipher_locked",
        "The account vault is locked; Router + Fusion cannot store or read content."
      )
    }
    return resolved
  }

  return {
    encrypted,
    async seal(table, primaryKey, field, value) {
      if (!encrypted) return { content: value, encryptedContent: null }
      const envelope = await cipher().encrypt(
        table,
        primaryKey,
        field,
        FUSION_CONTENT_SCHEMA_VERSION,
        value
      )
      return { content: null, encryptedContent: envelope }
    },
    async open(table, primaryKey, field, sealed) {
      if (sealed.encryptedContent) {
        return cipher().decrypt<string>(
          table,
          primaryKey,
          field,
          FUSION_CONTENT_SCHEMA_VERSION,
          sealed.encryptedContent
        )
      }
      if (encrypted) {
        // An account-scoped database never stores plaintext; a row without an
        // envelope there was not written by this codec.
        throw new RouterFusionInfrastructureError(
          "internal",
          `Unsealed content found in encrypted fusion table ${table}.`
        )
      }
      return sealed.content ?? ""
    },
  }
}
