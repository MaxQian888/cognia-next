"use client"

import { createKeyringStore, type KeyringStore } from "@/lib/credentials/keyring-store"
import { isCapacitor, isTauri } from "@/lib/tauri"
import { isHeadlessHost } from "@/lib/platform/detect"
import { getActiveBrowserVault } from "@/lib/runtime/browser-vault"
import { createBackupChunkCipher, type BackupChunkEncryptionConfig } from "@/lib/data/crypto"

const PROFILE_DEK_NAMESPACE = "retrieval-profile-dek/v1"
const ACTIVE_KEY_PREFIX = "active:"
const MATERIAL_KEY_PREFIX = "material:"

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
        return existing
      }

      const keyId = `dek-${now().toString(36)}-${crypto.randomUUID()}`
      const bytes = crypto.getRandomValues(new Uint8Array(32))
      try {
        await secretStore.save(materialKey(profileId, keyId), bytesToBase64(bytes))
        await secretStore.save(activeKey(profileId), keyId)
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

    async importPortable(
      envelope: PortableProfileDekEnvelopeV1,
      passphrase: string
    ): Promise<void> {
      assertAvailable()
      if (envelope.version !== 1) throw new ProfileDekProtocolError()
      if (!envelope.profileId || !envelope.keyId || !envelope.ciphertext) {
        throw new Error("Portable profile DEK envelope is incomplete")
      }
      if (!passphrase) throw new Error("A backup passphrase is required")
      const cipher = await createBackupChunkCipher(passphrase, envelope.encryption)
      const encoded = await cipher.open(
        0,
        envelope.ciphertext,
        portableAad(envelope.profileId, envelope.keyId)
      )
      const rawKey = base64ToBytes(encoded)
      try {
        await importDek(rawKey)
        await secretStore.save(
          materialKey(envelope.profileId, envelope.keyId),
          bytesToBase64(rawKey)
        )
        await secretStore.save(activeKey(envelope.profileId), envelope.keyId)
      } finally {
        rawKey.fill(0)
      }
    },

    async deleteProfile(profileId: string): Promise<void> {
      assertAvailable()
      const active = await secretStore.load(activeKey(profileId))
      if (active) await secretStore.delete(materialKey(profileId, active))
      await secretStore.delete(activeKey(profileId))
    },
  }
}
