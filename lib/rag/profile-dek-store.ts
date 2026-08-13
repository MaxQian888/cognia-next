"use client"

import { createKeyringStore, type KeyringStore } from "@/lib/credentials/keyring-store"
import { isCapacitor, isTauri } from "@/lib/tauri"
import { isHeadlessHost } from "@/lib/platform/detect"
import { getActiveBrowserVault } from "@/lib/runtime/browser-vault"
import { createBackupChunkCipher, type BackupChunkEncryptionConfig } from "@/lib/data/crypto"

const PROFILE_DEK_NAMESPACE = "retrieval-profile-dek/v1"
const ACTIVE_KEY_PREFIX = "active:"
const MATERIAL_KEY_PREFIX = "material:"
const PROFILE_REGISTRY_KEY = "profiles"

export interface ProfileDekHandle {
  profileId: string
  keyId: string
  key: CryptoKey
}

export interface ProfileDekPairingExportV1 {
  profileId: string
  keyId: string
  rawKey: Uint8Array
}

export interface PortableProfileDekEnvelopeV1 {
  version: 1
  profileId: string
  keyId: string
  encryption: BackupChunkEncryptionConfig
  ciphertext: string
}

export class RetrievalVaultLockedError extends Error {
  readonly code = "retrieval_vault_locked"

  constructor() {
    super("Browser Vault must be unlocked before retrieval content can be decrypted")
    this.name = "RetrievalVaultLockedError"
  }
}

export class ProfileDekProtocolError extends Error {
  readonly code = "upgrade_required"

  constructor() {
    super("Profile DEK protocol v1 is required")
    this.name = "ProfileDekProtocolError"
  }
}

export interface ProfileDekStoreDependencies {
  secretStore?: KeyringStore
  requireUnlocked?: () => boolean
  now?: () => number
}

export interface PortableProfileDekImportOptions {
  activate: "always" | "if-missing"
}

function bytesToBase64(bytes: Uint8Array): string {
  if (typeof btoa === "function") {
    let binary = ""
    for (const byte of bytes) binary += String.fromCharCode(byte)
    return btoa(binary)
  }
  return Buffer.from(bytes).toString("base64")
}

function base64ToBytes(value: string): Uint8Array {
  if (typeof atob === "function") {
    const binary = atob(value)
    return Uint8Array.from(binary, (character) => character.charCodeAt(0))
  }
  return new Uint8Array(Buffer.from(value, "base64"))
}

async function importDek(bytes: Uint8Array): Promise<CryptoKey> {
  if (bytes.length !== 32) throw new Error("Profile DEK must contain exactly 32 bytes")
  const rawKey = Uint8Array.from(bytes)
  return crypto.subtle.importKey("raw", rawKey, { name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ])
}

function activeKey(profileId: string): string {
  return `${ACTIVE_KEY_PREFIX}${profileId}`
}

function materialKey(profileId: string, keyId: string): string {
  return `${MATERIAL_KEY_PREFIX}${profileId}:${keyId}`
}

function defaultRequireUnlocked(): boolean {
  if (isTauri() || isCapacitor() || isHeadlessHost()) return true
  return getActiveBrowserVault() !== null
}

export function createProfileDekStore(dependencies: ProfileDekStoreDependencies = {}) {
  const secretStore = dependencies.secretStore ?? createKeyringStore(PROFILE_DEK_NAMESPACE)
  const requireUnlocked = dependencies.requireUnlocked ?? defaultRequireUnlocked
  const now = dependencies.now ?? Date.now

  function assertAvailable(): void {
    if (!requireUnlocked()) throw new RetrievalVaultLockedError()
    if (secretStore.isPersistent?.() === false) {
      throw new RetrievalVaultLockedError()
    }
  }

  async function load(profileId: string, keyId: string): Promise<ProfileDekHandle | null> {
    assertAvailable()
    const encoded = await secretStore.load(materialKey(profileId, keyId))
    if (!encoded) return null
    return { profileId, keyId, key: await importDek(base64ToBytes(encoded)) }
  }

  async function loadActiveMaterial(
    profileId: string
  ): Promise<{ keyId: string; encoded: string }> {
    assertAvailable()
    if (!profileId.trim()) throw new Error("Profile id is required")
    const keyId = await secretStore.load(activeKey(profileId))
    if (!keyId) throw new Error("Profile DEK is not provisioned")
    const encoded = await secretStore.load(materialKey(profileId, keyId))
    if (!encoded) throw new Error("Active profile DEK material is missing")
    return { keyId, encoded }
  }

  async function readProfileRegistry(): Promise<string[]> {
    const encoded = await secretStore.load(PROFILE_REGISTRY_KEY)
    if (encoded === null) return []
    let parsed: unknown
    try {
      parsed = JSON.parse(encoded)
    } catch {
      throw new Error("Profile DEK registry is corrupt")
    }
    if (!Array.isArray(parsed) || parsed.some((value) => typeof value !== "string" || !value)) {
      throw new Error("Profile DEK registry is corrupt")
    }
    return [...new Set(parsed)].sort()
  }

  async function writeProfileRegistry(profileIds: readonly string[]): Promise<void> {
    await secretStore.save(PROFILE_REGISTRY_KEY, JSON.stringify([...new Set(profileIds)].sort()))
  }

  async function registerProfile(profileId: string): Promise<void> {
    const current = await readProfileRegistry()
    if (!current.includes(profileId)) await writeProfileRegistry([...current, profileId])
  }

  async function restoreSecret(key: string, value: string | null): Promise<void> {
    if (value === null) await secretStore.delete(key)
    else await secretStore.save(key, value)
  }

  function assertPairingTransport(transport: {
    authenticated: boolean
    protocolVersion: number
  }): void {
    if (transport.protocolVersion !== 1) throw new ProfileDekProtocolError()
    if (!transport.authenticated) {
      throw new Error("Profile DEK export requires an authenticated pairing transport")
    }
  }

  function portableAad(profileId: string, keyId: string): string {
    return `profile-dek:${profileId}:${keyId}:v1`
  }

  return {
    async getOrCreate(profileId: string): Promise<ProfileDekHandle> {
      assertAvailable()
      if (!profileId.trim()) throw new Error("Profile id is required")
      const active = await secretStore.load(activeKey(profileId))
      if (active) {
        const existing = await load(profileId, active)
        if (!existing) throw new Error("Active profile DEK material is missing")
        await registerProfile(profileId)
        return existing
      }

      const keyId = `dek-${now().toString(36)}-${crypto.randomUUID()}`
      const bytes = crypto.getRandomValues(new Uint8Array(32))
      try {
        await secretStore.save(materialKey(profileId, keyId), bytesToBase64(bytes))
        await secretStore.save(activeKey(profileId), keyId)
        await registerProfile(profileId)
        return { profileId, keyId, key: await importDek(bytes) }
      } finally {
        bytes.fill(0)
      }
    },

    async load(profileId: string, keyId: string): Promise<ProfileDekHandle | null> {
      return load(profileId, keyId)
    },

    async rotate(profileId: string): Promise<ProfileDekHandle> {
      assertAvailable()
      await secretStore.delete(activeKey(profileId))
      return this.getOrCreate(profileId)
    },

    async importPaired(
      profileId: string,
      keyId: string,
      rawKey: Uint8Array,
      transport: { authenticated: boolean; protocolVersion: number }
    ): Promise<void> {
      assertAvailable()
      if (transport.protocolVersion !== 1) throw new ProfileDekProtocolError()
      if (!transport.authenticated) {
        throw new Error("Profile DEK import requires an authenticated pairing transport")
      }
      await importDek(rawKey)
      await secretStore.save(materialKey(profileId, keyId), bytesToBase64(rawKey))
      await secretStore.save(activeKey(profileId), keyId)
      await registerProfile(profileId)
    },

    async exportForPairing(
      profileId: string,
      transport: { authenticated: boolean; protocolVersion: number }
    ): Promise<ProfileDekPairingExportV1> {
      assertPairingTransport(transport)
      const { keyId, encoded } = await loadActiveMaterial(profileId)
      const rawKey = base64ToBytes(encoded)
      await importDek(rawKey)
      return { profileId, keyId, rawKey }
    },

    async exportPortable(
      profileId: string,
      passphrase: string
    ): Promise<PortableProfileDekEnvelopeV1> {
      if (!passphrase) throw new Error("A backup passphrase is required")
      const { keyId, encoded } = await loadActiveMaterial(profileId)
      const cipher = await createBackupChunkCipher(passphrase)
      return {
        version: 1,
        profileId,
        keyId,
        encryption: cipher.config,
        ciphertext: await cipher.seal(0, encoded, portableAad(profileId, keyId)),
      }
    },

    async listProfileIds(candidateProfileIds: readonly string[] = []): Promise<string[]> {
      assertAvailable()
      const candidates = new Set([...(await readProfileRegistry()), ...candidateProfileIds])
      const provisioned: string[] = []
      for (const profileId of [...candidates].sort()) {
        if (!profileId) continue
        if (await secretStore.load(activeKey(profileId))) provisioned.push(profileId)
      }
      if (provisioned.length > 0) await writeProfileRegistry(provisioned)
      return provisioned
    },

    async importPortableBatch(
      envelopes: readonly PortableProfileDekEnvelopeV1[],
      passphrase: string,
      options: PortableProfileDekImportOptions = { activate: "always" }
    ): Promise<void> {
      assertAvailable()
      if (!passphrase) throw new Error("A backup passphrase is required")
      const identities = new Set<string>()
      const prepared: Array<{
        envelope: PortableProfileDekEnvelopeV1
        rawKey: Uint8Array
        encoded: string
      }> = []
      try {
        for (const envelope of envelopes) {
          if (envelope.version !== 1) throw new ProfileDekProtocolError()
          if (!envelope.profileId || !envelope.keyId || !envelope.ciphertext) {
            throw new Error("Portable profile DEK envelope is incomplete")
          }
          if (identities.has(envelope.profileId)) {
            throw new Error(
              `Portable backup contains duplicate profile DEKs: ${envelope.profileId}`
            )
          }
          identities.add(envelope.profileId)
          const cipher = await createBackupChunkCipher(passphrase, envelope.encryption)
          const encoded = await cipher.open(
            0,
            envelope.ciphertext,
            portableAad(envelope.profileId, envelope.keyId)
          )
          const rawKey = base64ToBytes(encoded)
          await importDek(rawKey)
          prepared.push({ envelope, rawKey, encoded: bytesToBase64(rawKey) })
        }

        const touched = new Map<string, string | null>()
        const remember = async (key: string) => {
          if (!touched.has(key)) touched.set(key, await secretStore.load(key))
        }
        await remember(PROFILE_REGISTRY_KEY)
        try {
          for (const { envelope, encoded } of prepared) {
            const material = materialKey(envelope.profileId, envelope.keyId)
            const active = activeKey(envelope.profileId)
            await remember(material)
            await remember(active)
            await secretStore.save(material, encoded)
            if (options.activate === "always" || (await secretStore.load(active)) === null) {
              await secretStore.save(active, envelope.keyId)
            }
          }
          await writeProfileRegistry([
            ...(await readProfileRegistry()),
            ...prepared.map(({ envelope }) => envelope.profileId),
          ])
        } catch (error) {
          const rollbackErrors: unknown[] = []
          for (const [key, value] of [...touched.entries()].reverse()) {
            try {
              await restoreSecret(key, value)
            } catch (rollbackError) {
              rollbackErrors.push(rollbackError)
            }
          }
          if (rollbackErrors.length > 0) {
            throw new AggregateError(
              [error, ...rollbackErrors],
              "Profile DEK import rollback failed"
            )
          }
          throw error
        }
      } finally {
        for (const item of prepared) item.rawKey.fill(0)
      }
    },

    async importPortable(
      envelope: PortableProfileDekEnvelopeV1,
      passphrase: string,
      options: PortableProfileDekImportOptions = { activate: "always" }
    ): Promise<void> {
      await this.importPortableBatch([envelope], passphrase, options)
    },

    async deleteProfile(profileId: string): Promise<void> {
      assertAvailable()
      const active = await secretStore.load(activeKey(profileId))
      if (active) await secretStore.delete(materialKey(profileId, active))
      await secretStore.delete(activeKey(profileId))
      const profiles = await readProfileRegistry()
      await writeProfileRegistry(profiles.filter((candidate) => candidate !== profileId))
    },
  }
}
