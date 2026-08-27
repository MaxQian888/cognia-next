import Dexie, { type Table } from "dexie"

import { assertAccountId } from "@/lib/accounts/account-types"

export const BROWSER_VAULT_DB_NAME = "cognia-browser-vault"
export const BROWSER_VAULT_PBKDF2_ITERATIONS = 600_000

interface WrappedVaultKey {
  iv: string
  ciphertext: string
}

export interface BrowserVaultRecord {
  accountId: string
  version: 1
  passwordKdf: {
    algorithm: "PBKDF2"
    hash: "SHA-256"
    iterations: number
    salt: string
  }
  passwordWrap: WrappedVaultKey
  recoveryWrap: WrappedVaultKey
  createdAt: number
  updatedAt: number
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
        derivePasswordKey(password, passwordSalt),
        importAesKey(recoveryBytes, ["encrypt", "decrypt"]),
      ])
      const [passwordWrap, recoveryWrap, masterKey] = await Promise.all([
        wrapMasterKey(masterBytes, passwordKek, wrapAad(accountId, "password")),
        wrapMasterKey(masterBytes, recoveryKek, wrapAad(accountId, "recovery")),
        importAesKey(masterBytes, ["encrypt", "decrypt"]),
      ])
      const record: BrowserVaultRecord = {
        accountId,
        version: 1,
        passwordKdf: {
          algorithm: "PBKDF2",
          hash: "SHA-256",
          iterations: BROWSER_VAULT_PBKDF2_ITERATIONS,
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
    const passwordKey = await derivePasswordKey(
      password,
      decodeBase64Url(record.passwordKdf.salt),
      record.passwordKdf.iterations
    )
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

export async function provisionBrowserVault(accountId: string, password: string): Promise<string> {
  const created = await BrowserVaultSession.create(accountId, password)
  await repository().put(created.record)
  activeBrowserVaultSession?.lock()
  activeBrowserVaultSession = created.session
  return created.recoveryKey
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
  const currentPasswordKey = await derivePasswordKey(
    currentPassword,
    decodeBase64Url(current.passwordKdf.salt),
    current.passwordKdf.iterations
  )
  const masterBytes = await unwrapMasterKey(
    current.passwordWrap,
    currentPasswordKey,
    wrapAad(accountId, "password")
  )
  const nextSalt = randomBytes(16)
  try {
    const nextPasswordKey = await derivePasswordKey(newPassword, nextSalt)
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
        passwordKdf: {
          ...current.passwordKdf,
          salt: encodeBase64Url(nextSalt),
          iterations: BROWSER_VAULT_PBKDF2_ITERATIONS,
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
      const nextPasswordKey = await derivePasswordKey(newPassword, nextSalt)
      const passwordWrap = await wrapMasterKey(
        masterBytes,
        nextPasswordKey,
        wrapAad(accountId, "password")
      )
      await repository().put({
        ...current,
        passwordKdf: {
          ...current.passwordKdf,
          salt: encodeBase64Url(nextSalt),
          iterations: BROWSER_VAULT_PBKDF2_ITERATIONS,
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

function wrapAad(accountId: string, kind: "password" | "recovery"): Uint8Array {
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
  if (
    record.version !== 1 ||
    record.passwordKdf.algorithm !== "PBKDF2" ||
    record.passwordKdf.hash !== "SHA-256" ||
    record.passwordKdf.iterations !== BROWSER_VAULT_PBKDF2_ITERATIONS
  ) {
    throw new Error("Browser Vault record is incompatible.")
  }
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
