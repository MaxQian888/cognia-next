import Dexie, { type Table } from "dexie"
import { argon2idAsync } from "@noble/hashes/argon2.js"

import { assertAccountId } from "@/lib/accounts/account-types"
import { AccountContentCipher } from "@/lib/accounts/content-cipher"
import type { QuickUnlockMethod } from "@/lib/accounts/quick-unlock/types"

export const BROWSER_VAULT_DB_NAME = "cognia-browser-vault"
export const BROWSER_VAULT_PBKDF2_ITERATIONS = 600_000
export const BROWSER_VAULT_ARGON2_MEMORY_KIB = 19_456
export const BROWSER_VAULT_ARGON2_TIME_COST = 2
export const BROWSER_VAULT_ARGON2_PARALLELISM = 1

interface Argon2Parameters {
  memoryKiB: number
  timeCost: number
  parallelism: number
}

let activeArgon2Parameters: Argon2Parameters = {
  memoryKiB: BROWSER_VAULT_ARGON2_MEMORY_KIB,
  timeCost: BROWSER_VAULT_ARGON2_TIME_COST,
  parallelism: BROWSER_VAULT_ARGON2_PARALLELISM,
}

interface WrappedVaultKey {
  iv: string
  ciphertext: string
}

export interface BrowserVaultRecord {
  accountId: string
  version: 1 | 2
  passwordKdf:
    | {
        algorithm: "PBKDF2"
        hash: "SHA-256"
        iterations: number
        salt: string
      }
    | {
        algorithm: "Argon2id"
        version: 0x13
        memoryKiB: number
        timeCost: number
        parallelism: number
        outputLength: 32
        salt: string
      }
  passwordWrap: WrappedVaultKey
  recoveryWrap: WrappedVaultKey
  /**
   * Quick-unlock wraps of the SAME master key, one per enrolled method.
   *
   * Optional, and deliberately not a version bump: a record carrying these is
   * still a v2 record, so every vault minted before quick unlock existed keeps
   * validating and opening unchanged.
   *
   * Each wrap is keyed by a KEK derived from the user's low-entropy secret
   * COMBINED with this device's pepper. Without the pepper the wrap cannot be
   * attacked offline at all, which is the only reason a six-digit PIN is
   * allowed near a master key. See `lib/accounts/quick-unlock/device-pepper`.
   */
  quickWraps?: Partial<Record<QuickUnlockMethod, QuickUnlockWrap>>
  createdAt: number
  updatedAt: number
}

/** AAD domains. Each wrap is bound to its own, so one cannot open another. */
type WrapKind = "password" | "recovery" | QuickUnlockMethod

export interface QuickUnlockWrap {
  /** Argon2id salt for the secret half of the KEK. */
  salt: string
  memoryKiB: number
  timeCost: number
  parallelism: number
  wrap: WrappedVaultKey
  createdAt: number
}

export interface EncryptedVaultSecret {
  version: 1
  iv: string
  ciphertext: string
}

export interface BrowserVaultSecretRecord {
  accountId: string
  name: string
  secret: EncryptedVaultSecret
  updatedAt: number
}

class BrowserVaultDB extends Dexie {
  vaults!: Table<BrowserVaultRecord, string>
  secrets!: Table<BrowserVaultSecretRecord, [string, string]>

  constructor(name = BROWSER_VAULT_DB_NAME) {
    super(name)
    this.version(1).stores({ vaults: "&accountId, updatedAt" })
    this.version(2).stores({
      vaults: "&accountId, updatedAt",
      secrets: "&[accountId+name], accountId, updatedAt",
    })
  }
}

export class BrowserVaultRepository {
  constructor(private readonly db: BrowserVaultDB = new BrowserVaultDB()) {}

  get(accountId: string): Promise<BrowserVaultRecord | undefined> {
    return this.db.vaults.get(assertAccountId(accountId))
  }

  async put(record: BrowserVaultRecord): Promise<void> {
    assertAccountId(record.accountId)
    await this.db.vaults.put(record)
  }

  async delete(accountId: string): Promise<void> {
    const normalized = assertAccountId(accountId)
    await this.db.transaction("rw", this.db.vaults, this.db.secrets, async () => {
      await this.db.vaults.delete(normalized)
      await this.db.secrets.where("accountId").equals(normalized).delete()
    })
  }

  getSecret(accountId: string, name: string): Promise<BrowserVaultSecretRecord | undefined> {
    return this.db.secrets.get([assertAccountId(accountId), assertSecretName(name)])
  }

  async putSecret(record: BrowserVaultSecretRecord): Promise<void> {
    const normalized: BrowserVaultSecretRecord = {
      ...record,
      accountId: assertAccountId(record.accountId),
      name: assertSecretName(record.name),
    }
    await this.db.secrets.put(normalized)
  }

  async deleteSecret(accountId: string, name: string): Promise<void> {
    await this.db.secrets.delete([assertAccountId(accountId), assertSecretName(name)])
  }

  close(): void {
    this.db.close()
  }
}

export class BrowserVaultSession {
  private masterKey: CryptoKey | null

  constructor(
    readonly accountId: string,
    masterKey: CryptoKey
  ) {
    this.masterKey = masterKey
  }

  static async create(
    accountId: string,
    password: string,
    now = Date.now()
  ): Promise<{
    record: BrowserVaultRecord
    recoveryKey: string
    session: BrowserVaultSession
  }> {
    assertAccountId(accountId)
    assertPassword(password)
    const masterBytes = randomBytes(32)
    const recoveryBytes = randomBytes(32)
    const passwordSalt = randomBytes(16)
    try {
      const [passwordKek, recoveryKek] = await Promise.all([
        deriveArgon2PasswordKey(password, passwordSalt),
        importAesKey(recoveryBytes, ["encrypt", "decrypt"]),
      ])
      const [passwordWrap, recoveryWrap, masterKey] = await Promise.all([
        wrapMasterKey(masterBytes, passwordKek, wrapAad(accountId, "password")),
        wrapMasterKey(masterBytes, recoveryKek, wrapAad(accountId, "recovery")),
        importAesKey(masterBytes, ["encrypt", "decrypt"]),
      ])
      const record: BrowserVaultRecord = {
        accountId,
        version: 2,
        passwordKdf: {
          algorithm: "Argon2id",
          version: 0x13,
          memoryKiB: activeArgon2Parameters.memoryKiB,
          timeCost: activeArgon2Parameters.timeCost,
          parallelism: activeArgon2Parameters.parallelism,
          outputLength: 32,
          salt: encodeBase64Url(passwordSalt),
        },
        passwordWrap,
        recoveryWrap,
        createdAt: now,
        updatedAt: now,
      }
      return {
        record,
        recoveryKey: encodeBase64Url(recoveryBytes),
        session: new BrowserVaultSession(accountId, masterKey),
      }
    } finally {
      zeroBytes(masterBytes)
      zeroBytes(recoveryBytes)
      zeroBytes(passwordSalt)
    }
  }

  static async unlockWithPassword(
    record: BrowserVaultRecord,
    password: string
  ): Promise<BrowserVaultSession> {
    validateRecord(record)
    assertPassword(password)
    const passwordKey = await derivePasswordKeyForRecord(record, password)
    const masterBytes = await unwrapMasterKey(
      record.passwordWrap,
      passwordKey,
      wrapAad(record.accountId, "password")
    )
    try {
      return new BrowserVaultSession(
        record.accountId,
        await importAesKey(masterBytes, ["encrypt", "decrypt"])
      )
    } finally {
      zeroBytes(masterBytes)
    }
  }

  static async unlockWithRecoveryKey(
    record: BrowserVaultRecord,
    recoveryKey: string
  ): Promise<BrowserVaultSession> {
    validateRecord(record)
    const recoveryBytes = decodeBase64Url(recoveryKey)
    if (recoveryBytes.length !== 32) {
      throw new Error("Vault recovery key is malformed.")
    }
    try {
      const recoveryKek = await importAesKey(recoveryBytes, ["decrypt"])
      const masterBytes = await unwrapMasterKey(
        record.recoveryWrap,
        recoveryKek,
        wrapAad(record.accountId, "recovery")
      )
      try {
        return new BrowserVaultSession(
          record.accountId,
          await importAesKey(masterBytes, ["encrypt", "decrypt"])
        )
      } finally {
        zeroBytes(masterBytes)
      }
    } finally {
      zeroBytes(recoveryBytes)
    }
  }

  isUnlocked(): boolean {
    return this.masterKey !== null
  }

  createContentCipher(databaseName: string): AccountContentCipher {
    return new AccountContentCipher(this.accountId, databaseName, this.requireMasterKey())
  }

  lock(): void {
    this.masterKey = null
  }

  async encryptSecret(name: string, value: string): Promise<EncryptedVaultSecret> {
    const key = this.requireMasterKey()
    const iv = randomBytes(12)
    const ciphertext = await subtle().encrypt(
      {
        name: "AES-GCM",
        iv: toBufferSource(iv),
        additionalData: toBufferSource(secretAad(this.accountId, name)),
      },
      key,
      toBufferSource(new TextEncoder().encode(value))
    )
    return {
      version: 1,
      iv: encodeBase64Url(iv),
      ciphertext: encodeBase64Url(new Uint8Array(ciphertext)),
    }
  }

  async decryptSecret(name: string, secret: EncryptedVaultSecret): Promise<string> {
    const key = this.requireMasterKey()
    const plaintext = await subtle().decrypt(
      {
        name: "AES-GCM",
        iv: toBufferSource(decodeBase64Url(secret.iv)),
        additionalData: toBufferSource(secretAad(this.accountId, name)),
      },
      key,
      toBufferSource(decodeBase64Url(secret.ciphertext))
    )
    return new TextDecoder().decode(plaintext)
  }

  async storeSecret(name: string, value: string, now = Date.now()): Promise<void> {
    const normalized = assertSecretName(name)
    await repository().putSecret({
      accountId: this.accountId,
      name: normalized,
      secret: await this.encryptSecret(normalized, value),
      updatedAt: now,
    })
  }

  async loadSecret(name: string): Promise<string | null> {
    const normalized = assertSecretName(name)
    const record = await repository().getSecret(this.accountId, normalized)
    return record ? this.decryptSecret(normalized, record.secret) : null
  }

  async deleteSecret(name: string): Promise<void> {
    await repository().deleteSecret(this.accountId, assertSecretName(name))
  }

  private requireMasterKey(): CryptoKey {
    if (!this.masterKey) throw new Error("Browser Vault is locked.")
    return this.masterKey
  }
}

let activeBrowserVaultSession: BrowserVaultSession | null = null
let browserVaultRepository: BrowserVaultRepository | null = null

export async function provisionBrowserVault(
  accountId: string,
  password: string,
  activate = true
): Promise<string> {
  const created = await BrowserVaultSession.create(accountId, password)
  await repository().put(created.record)
  if (activate) {
    activeBrowserVaultSession?.lock()
    activeBrowserVaultSession = created.session
  } else {
    created.session.lock()
  }
  return created.recoveryKey
}

export async function browserVaultExists(accountId: string): Promise<boolean> {
  return (await repository().get(accountId)) !== undefined
}

/**
 * Combine a low-entropy secret with this device's pepper into a KEK.
 *
 * The pepper is appended to the Argon2 password input rather than mixed into
 * the salt. Salts are stored in the clear next to the wrap, so peppering there
 * would hand an attacker the material the whole scheme depends on staying off
 * disk. Appending keeps it purely in memory, derived from a key that never
 * leaves the device.
 */
async function deriveQuickUnlockKey(
  canonicalSecret: string,
  pepper: Uint8Array,
  salt: Uint8Array,
  parameters: Argon2Parameters
): Promise<CryptoKey> {
  const secretBytes = new TextEncoder().encode(canonicalSecret)
  const combined = new Uint8Array(secretBytes.length + pepper.length)
  combined.set(secretBytes, 0)
  combined.set(pepper, secretBytes.length)
  try {
    const derived = await argon2idAsync(combined, salt, {
      t: parameters.timeCost,
      m: parameters.memoryKiB,
      p: parameters.parallelism,
      version: 0x13,
      dkLen: 32,
      asyncTick: 8,
      maxmem: parameters.memoryKiB * 1024 + 1024 * 1024,
    })
    try {
      return await importAesKey(derived, ["encrypt", "decrypt"])
    } finally {
      zeroBytes(derived)
    }
  } finally {
    zeroBytes(secretBytes)
    zeroBytes(combined)
  }
}

/**
 * Enroll a quick-unlock method by wrapping the master key under it.
 *
 * Requires the CURRENT PASSWORD, not merely an unlocked session. Enrollment
 * mints a new way into the account, and the bar for that has to be proof of
 * the factor it is being layered onto. An unlocked-session check would let
 * anyone who walked up to a signed-in machine add their own PIN.
 */
export async function enrollBrowserVaultQuickUnlock(args: {
  accountId: string
  method: QuickUnlockMethod
  password: string
  canonicalSecret: string
  pepper: Uint8Array
  now?: number
}): Promise<QuickUnlockWrap> {
  const { accountId, method, password, canonicalSecret, pepper } = args
  const now = args.now ?? Date.now()
  const record = await repository().get(accountId)
  if (!record) throw new Error("Browser Vault is not provisioned for this account.")

  const passwordKey = await derivePasswordKeyForRecord(record, password)
  const masterBytes = await unwrapMasterKey(
    record.passwordWrap,
    passwordKey,
    wrapAad(accountId, "password")
  )
  const salt = randomBytes(16)
  try {
    const parameters = { ...activeArgon2Parameters }
    const kek = await deriveQuickUnlockKey(canonicalSecret, pepper, salt, parameters)
    const wrap = await wrapMasterKey(masterBytes, kek, wrapAad(accountId, method))
    const entry: QuickUnlockWrap = {
      salt: encodeBase64Url(salt),
      memoryKiB: parameters.memoryKiB,
      timeCost: parameters.timeCost,
      parallelism: parameters.parallelism,
      wrap,
      createdAt: now,
    }
    await repository().put({
      ...record,
      quickWraps: { ...(record.quickWraps ?? {}), [method]: entry },
      updatedAt: now,
    })
    return entry
  } finally {
    zeroBytes(masterBytes)
    zeroBytes(salt)
  }
}

/**
 * Open the vault with a quick-unlock secret.
 *
 * Throws on a wrong secret, exactly as the password path does. The caller owns
 * the attempt cap: this layer cannot, because it has no memory between calls.
 */
export async function unlockBrowserVaultWithQuickSecret(args: {
  accountId: string
  method: QuickUnlockMethod
  canonicalSecret: string
  pepper: Uint8Array
}): Promise<void> {
  const { accountId, method, canonicalSecret, pepper } = args
  const record = await repository().get(accountId)
  if (!record) throw new Error("Browser Vault is not provisioned for this account.")
  validateRecord(record)

  const entry = record.quickWraps?.[method]
  if (!entry) throw new Error("That unlock method is not enrolled on this account.")

  const salt = decodeBase64Url(entry.salt)
  try {
    // The ENTRY's parameters, never the current globals. A future cost bump
    // must not lock a user out of a PIN minted under the old settings, which
    // is the same trap `derivePasswordKeyForRecord` documents.
    const kek = await deriveQuickUnlockKey(canonicalSecret, pepper, salt, {
      memoryKiB: entry.memoryKiB,
      timeCost: entry.timeCost,
      parallelism: entry.parallelism,
    })
    const masterBytes = await unwrapMasterKey(entry.wrap, kek, wrapAad(accountId, method))
    try {
      const session = new BrowserVaultSession(
        accountId,
        await importAesKey(masterBytes, ["encrypt", "decrypt"])
      )
      activeBrowserVaultSession?.lock()
      activeBrowserVaultSession = session
    } finally {
      zeroBytes(masterBytes)
    }
  } finally {
    zeroBytes(salt)
  }
}

/** Drop one enrolled method. The vault and every other method are untouched. */
export async function removeBrowserVaultQuickUnlock(
  accountId: string,
  method: QuickUnlockMethod,
  now = Date.now()
): Promise<void> {
  const record = await repository().get(accountId)
  if (!record?.quickWraps?.[method]) return
  const next = { ...record.quickWraps }
  delete next[method]
  await repository().put({ ...record, quickWraps: next, updatedAt: now })
}

/** Which methods currently have a wrap on this account. */
export async function listBrowserVaultQuickUnlockMethods(
  accountId: string
): Promise<QuickUnlockMethod[]> {
  const record = await repository().get(accountId)
  if (!record?.quickWraps) return []
  return Object.keys(record.quickWraps) as QuickUnlockMethod[]
}

export async function unlockBrowserVault(accountId: string, password: string): Promise<void> {
  const record = await repository().get(accountId)
  if (!record) throw new Error("Browser Vault is not provisioned for this account.")
  const session = await BrowserVaultSession.unlockWithPassword(record, password)
  activeBrowserVaultSession?.lock()
  activeBrowserVaultSession = session
}

export async function verifyBrowserVaultPassword(
  accountId: string,
  password: string
): Promise<boolean> {
  const record = await repository().get(accountId)
  if (!record) throw new Error("Browser Vault is not provisioned for this account.")
  try {
    const verificationSession = await BrowserVaultSession.unlockWithPassword(record, password)
    verificationSession.lock()
    return true
  } catch {
    return false
  }
}

export async function changeBrowserVaultPassword(
  accountId: string,
  currentPassword: string,
  newPassword: string,
  now = Date.now()
): Promise<void> {
  const current = await repository().get(accountId)
  if (!current) throw new Error("Browser Vault is not provisioned for this account.")
  const currentPasswordKey = await derivePasswordKeyForRecord(current, currentPassword)
  const masterBytes = await unwrapMasterKey(
    current.passwordWrap,
    currentPasswordKey,
    wrapAad(accountId, "password")
  )
  const nextSalt = randomBytes(16)
  try {
    const nextPasswordKey = await deriveArgon2PasswordKey(newPassword, nextSalt)
    const passwordWrap = await wrapMasterKey(
      masterBytes,
      nextPasswordKey,
      wrapAad(accountId, "password")
    )
    const session = new BrowserVaultSession(
      accountId,
      await importAesKey(masterBytes, ["encrypt", "decrypt"])
    )
    try {
      await repository().put({
        ...current,
        version: 2,
        passwordKdf: {
          algorithm: "Argon2id",
          version: 0x13,
          memoryKiB: activeArgon2Parameters.memoryKiB,
          timeCost: activeArgon2Parameters.timeCost,
          parallelism: activeArgon2Parameters.parallelism,
          outputLength: 32,
          salt: encodeBase64Url(nextSalt),
        },
        passwordWrap,
        updatedAt: now,
      })
    } catch (error) {
      session.lock()
      throw error
    }
    activeBrowserVaultSession?.lock()
    activeBrowserVaultSession = session
  } finally {
    zeroBytes(masterBytes)
    zeroBytes(nextSalt)
  }
}

/**
 * Redeem the one-time recovery key: unwrap the master key from `recoveryWrap`,
 * re-wrap it under a new password, and leave the vault unlocked.
 *
 * This is the only path back into an account whose password is lost. It has to
 * rotate the password rather than merely unlock, because unlocking alone leaves
 * `passwordWrap` keyed to the forgotten password — the user would be locked out
 * again on the next lock.
 *
 * `recoveryWrap` is deliberately NOT rotated. The recovery key is the root of
 * trust for the vault (the master key is not derivable from anything else), so
 * minting a replacement here would silently invalidate the copy the user
 * printed or filed away, at the exact moment they proved they still have it.
 * Rotating it is a separate, explicit act.
 */
export async function resetBrowserVaultPasswordWithRecoveryKey(
  accountId: string,
  recoveryKey: string,
  newPassword: string,
  now = Date.now()
): Promise<void> {
  const current = await repository().get(accountId)
  if (!current) throw new Error("Browser Vault is not provisioned for this account.")
  assertPassword(newPassword)
  // Proves the recovery key before anything is written, and normalizes a
  // malformed key into the same error the unlock path reports.
  const recovered = await BrowserVaultSession.unlockWithRecoveryKey(current, recoveryKey)
  const recoveryBytes = decodeBase64Url(recoveryKey)
  const nextSalt = randomBytes(16)
  try {
    const recoveryKek = await importAesKey(recoveryBytes, ["decrypt"])
    const masterBytes = await unwrapMasterKey(
      current.recoveryWrap,
      recoveryKek,
      wrapAad(accountId, "recovery")
    )
    try {
      const nextPasswordKey = await deriveArgon2PasswordKey(newPassword, nextSalt)
      const passwordWrap = await wrapMasterKey(
        masterBytes,
        nextPasswordKey,
        wrapAad(accountId, "password")
      )
      await repository().put({
        ...current,
        version: 2,
        passwordKdf: {
          algorithm: "Argon2id",
          version: 0x13,
          memoryKiB: activeArgon2Parameters.memoryKiB,
          timeCost: activeArgon2Parameters.timeCost,
          parallelism: activeArgon2Parameters.parallelism,
          outputLength: 32,
          salt: encodeBase64Url(nextSalt),
        },
        passwordWrap,
        updatedAt: now,
      })
    } finally {
      zeroBytes(masterBytes)
    }
  } catch (error) {
    recovered.lock()
    throw error
  } finally {
    zeroBytes(recoveryBytes)
    zeroBytes(nextSalt)
  }
  activeBrowserVaultSession?.lock()
  activeBrowserVaultSession = recovered
}

export function getActiveBrowserVault(): BrowserVaultSession | null {
  return activeBrowserVaultSession
}

export function lockBrowserVault(): void {
  activeBrowserVaultSession?.lock()
  activeBrowserVaultSession = null
}

export async function deleteBrowserVault(accountId: string): Promise<void> {
  if (activeBrowserVaultSession?.accountId === accountId) lockBrowserVault()
  await repository().delete(accountId)
}

function repository(): BrowserVaultRepository {
  browserVaultRepository ??= new BrowserVaultRepository()
  return browserVaultRepository
}

export function __resetBrowserVaultForTesting(): void {
  lockBrowserVault()
  browserVaultRepository?.close()
  browserVaultRepository = null
  activeArgon2Parameters = {
    memoryKiB: BROWSER_VAULT_ARGON2_MEMORY_KIB,
    timeCost: BROWSER_VAULT_ARGON2_TIME_COST,
    parallelism: BROWSER_VAULT_ARGON2_PARALLELISM,
  }
}

/**
 * Test-only: mint a v1 (PBKDF2) record the way the pre-Argon2 build did.
 *
 * There is no other way to obtain one — `create` mints v2 — so without this the
 * legacy unlock path had no coverage at all, which is exactly how a wiped salt
 * on that branch shipped: every Argon2 test passed while every existing vault
 * became unopenable. Any change to `derivePasswordKeyForRecord` must keep this
 * green.
 */
export async function __createLegacyPbkdf2VaultRecordForTesting(
  accountId: string,
  password: string,
  now = Date.now()
): Promise<BrowserVaultRecord> {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Legacy vault record minting is test-only.")
  }
  assertAccountId(accountId)
  const masterBytes = randomBytes(32)
  const recoveryBytes = randomBytes(32)
  const passwordSalt = randomBytes(16)
  try {
    const passwordKek = await derivePasswordKey(password, passwordSalt)
    const recoveryKek = await importAesKey(recoveryBytes, ["encrypt", "decrypt"])
    return {
      accountId,
      version: 1,
      passwordKdf: {
        algorithm: "PBKDF2",
        hash: "SHA-256",
        iterations: BROWSER_VAULT_PBKDF2_ITERATIONS,
        salt: encodeBase64Url(passwordSalt),
      },
      passwordWrap: await wrapMasterKey(masterBytes, passwordKek, wrapAad(accountId, "password")),
      recoveryWrap: await wrapMasterKey(masterBytes, recoveryKek, wrapAad(accountId, "recovery")),
      createdAt: now,
      updatedAt: now,
    }
  } finally {
    zeroBytes(masterBytes)
    zeroBytes(recoveryBytes)
    zeroBytes(passwordSalt)
  }
}

export function __setBrowserVaultArgon2ParametersForTesting(memoryKiB: number): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Argon2 parameter overrides are test-only.")
  }
  activeArgon2Parameters = {
    memoryKiB,
    timeCost: 1,
    parallelism: 1,
  }
}

async function derivePasswordKey(
  password: string,
  salt: Uint8Array,
  iterations = BROWSER_VAULT_PBKDF2_ITERATIONS
): Promise<CryptoKey> {
  const material = await subtle().importKey(
    "raw",
    toBufferSource(new TextEncoder().encode(password)),
    "PBKDF2",
    false,
    ["deriveKey"]
  )
  return subtle().deriveKey(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: toBufferSource(salt),
      iterations,
    },
    material,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  )
}

/**
 * Derive the password KEK.
 *
 * `parameters` defaults to today's settings — that is the MINT path. Reading an
 * existing record must pass the parameters that record was written with: a
 * record minted under different cost settings derives a different key, so
 * deriving with the current globals would silently produce the wrong KEK the
 * moment those globals change.
 */
async function deriveArgon2PasswordKey(
  password: string,
  salt: Uint8Array,
  parameters: Argon2Parameters = activeArgon2Parameters
): Promise<CryptoKey> {
  const passwordBytes = new TextEncoder().encode(password)
  try {
    const derived = await argon2idAsync(passwordBytes, salt, {
      t: parameters.timeCost,
      m: parameters.memoryKiB,
      p: parameters.parallelism,
      version: 0x13,
      dkLen: 32,
      asyncTick: 8,
      maxmem: parameters.memoryKiB * 1024 + 1024 * 1024,
    })
    try {
      return await importAesKey(derived, ["encrypt", "decrypt"])
    } finally {
      zeroBytes(derived)
    }
  } finally {
    zeroBytes(passwordBytes)
  }
}

async function derivePasswordKeyForRecord(
  record: BrowserVaultRecord,
  password: string
): Promise<CryptoKey> {
  const salt = decodeBase64Url(record.passwordKdf.salt)
  try {
    // AWAIT before the `finally` wipes the salt. `derivePasswordKey` suspends
    // on `importKey` BEFORE it reads `salt`, so `return derivePasswordKey(...)`
    // handed PBKDF2 an all-zero salt and made every legacy v1 record
    // permanently unopenable. Argon2 happened to survive because `argon2Init`
    // consumes the salt synchronously — a difference no reader should have to
    // know about, so both branches await here.
    if (record.passwordKdf.algorithm === "PBKDF2") {
      return await derivePasswordKey(password, salt, record.passwordKdf.iterations)
    }
    // The RECORD's parameters, not the current globals — see
    // `deriveArgon2PasswordKey`.
    return await deriveArgon2PasswordKey(password, salt, {
      memoryKiB: record.passwordKdf.memoryKiB,
      timeCost: record.passwordKdf.timeCost,
      parallelism: record.passwordKdf.parallelism,
    })
  } finally {
    zeroBytes(salt)
  }
}

async function importAesKey(bytes: Uint8Array, usages: KeyUsage[]): Promise<CryptoKey> {
  return subtle().importKey(
    "raw",
    toBufferSource(bytes),
    { name: "AES-GCM", length: 256 },
    false,
    usages
  )
}

async function wrapMasterKey(
  masterBytes: Uint8Array,
  key: CryptoKey,
  additionalData: Uint8Array
): Promise<WrappedVaultKey> {
  const iv = randomBytes(12)
  const ciphertext = await subtle().encrypt(
    {
      name: "AES-GCM",
      iv: toBufferSource(iv),
      additionalData: toBufferSource(additionalData),
    },
    key,
    toBufferSource(masterBytes)
  )
  return {
    iv: encodeBase64Url(iv),
    ciphertext: encodeBase64Url(new Uint8Array(ciphertext)),
  }
}

async function unwrapMasterKey(
  wrapped: WrappedVaultKey,
  key: CryptoKey,
  additionalData: Uint8Array
): Promise<Uint8Array> {
  const plaintext = await subtle().decrypt(
    {
      name: "AES-GCM",
      iv: toBufferSource(decodeBase64Url(wrapped.iv)),
      additionalData: toBufferSource(additionalData),
    },
    key,
    toBufferSource(decodeBase64Url(wrapped.ciphertext))
  )
  return new Uint8Array(plaintext)
}

function wrapAad(accountId: string, kind: WrapKind): Uint8Array {
  return new TextEncoder().encode(`cognia-vault:v1:${accountId}:${kind}`)
}

function secretAad(accountId: string, name: string): Uint8Array {
  const normalized = assertSecretName(name)
  return new TextEncoder().encode(`cognia-vault-secret:v1:${accountId}:${normalized}`)
}

function assertSecretName(name: string): string {
  const normalized = name.trim()
  if (!normalized) throw new Error("Vault secret name is required.")
  return normalized
}

function validateRecord(record: BrowserVaultRecord): void {
  assertAccountId(record.accountId)
  const compatibleLegacy =
    record.version === 1 &&
    record.passwordKdf.algorithm === "PBKDF2" &&
    record.passwordKdf.hash === "SHA-256" &&
    record.passwordKdf.iterations === BROWSER_VAULT_PBKDF2_ITERATIONS
  // Validate the record's Argon2 parameters STRUCTURALLY, never against the
  // current `activeArgon2Parameters`. The KDF runs with whatever the record
  // itself stores (`derivePasswordKeyForRecord`), so an equality check bought
  // nothing and turned any future hardening bump — the entire point of a
  // tunable KDF — into a lockout for every vault minted before it. Current
  // strength is pinned where it belongs: on the mint path
  // (`BrowserVaultSession.create`, `changeBrowserVaultPassword`,
  // `resetBrowserVaultPasswordWithRecoveryKey`), which always writes today's
  // parameters. A record cannot be silently weakened either: rewriting the
  // parameters without the password only breaks the AES-GCM unwrap.
  const compatibleArgon2 =
    record.version === 2 &&
    record.passwordKdf.algorithm === "Argon2id" &&
    record.passwordKdf.version === 0x13 &&
    isPositiveInteger(record.passwordKdf.memoryKiB) &&
    isPositiveInteger(record.passwordKdf.timeCost) &&
    isPositiveInteger(record.passwordKdf.parallelism) &&
    record.passwordKdf.outputLength === 32
  if (!compatibleLegacy && !compatibleArgon2)
    throw new Error("Browser Vault record is incompatible.")
}

function isPositiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0
}

function assertPassword(password: string): void {
  if (!password.trim()) throw new Error("Browser Vault password is required.")
}

function randomBytes(length: number): Uint8Array {
  if (!globalThis.crypto?.getRandomValues) {
    throw new Error("Secure random source is required for Browser Vault.")
  }
  return globalThis.crypto.getRandomValues(new Uint8Array(length))
}

function subtle(): SubtleCrypto {
  if (!globalThis.crypto?.subtle) {
    throw new Error("Web Crypto API is required for Browser Vault.")
  }
  return globalThis.crypto.subtle
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function decodeBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/")
  const padding = "=".repeat((4 - (normalized.length % 4)) % 4)
  const binary = atob(`${normalized}${padding}`)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

function toBufferSource(bytes: Uint8Array): BufferSource {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

function zeroBytes(bytes: Uint8Array): void {
  bytes.fill(0)
}
