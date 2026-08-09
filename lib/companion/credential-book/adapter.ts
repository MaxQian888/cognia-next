"use client"

/**
 * `CompanionConfigStorage` implemented over the credential book.
 *
 * Everything downstream of a pairing — the transport, the connectivity
 * strategy, the sync orchestrator, the endpoint refresher — reads a
 * {@link CompanionConfig}. Rewriting all of them against the book at once
 * would be one enormous, unreviewable change, so the book ships behind the
 * existing interface: the same shape goes in and out, but the storage
 * underneath is now multi-host and split by sensitivity.
 *
 * The adapter therefore answers for the account's **active** host, and `save()`
 * upserts that host rather than overwriting a global singleton. Callers that
 * genuinely need multi-host behaviour (Settings, host switching) talk to the
 * book directly.
 */
import { importV2SigningPrivateKey } from "@/lib/signaling/v2-crypto"
import type { CompanionConfig, CompanionConfigStorage } from "@/lib/tauri/companion-storage"

import { legacyHostId, legacyLabel } from "./legacy-migration"
import {
  DEFAULT_ACCOUNT_NAMESPACE,
  hostKeyOf,
  type CompanionCredentialBook,
  type CompanionHostCredential,
  type CompanionHostRecord,
} from "./types"

export interface CredentialBookAdapterOptions {
  book: CompanionCredentialBook
  /**
   * The account whose active host this adapter speaks for.
   *
   * A function rather than a value: the active account changes at runtime
   * (account switch, Vault unlock), and an adapter pinned to boot-time state
   * would keep serving the previous account's pairing.
   */
  accountNamespace: () => string | null
  /**
   * Runtime-selected host id. `undefined` falls back to the book pointer for
   * native clients without runtime targets; `null` explicitly selects no
   * Companion host (for example the browser's standalone target).
   */
  activeHostId?: () => string | null | undefined
}

/** Rebuild the flat config the rest of the app still expects. */
export async function toCompanionConfig(
  record: CompanionHostRecord,
  credential: CompanionHostCredential
): Promise<CompanionConfig> {
  const config: CompanionConfig = {
    targetId: record.hostId,
    baseUrl: record.endpoints.baseUrl,
    devicePrivateKeyJwk: credential.devicePrivateKeyJwk,
    deviceKeyThumbprint: record.deviceKeyThumbprint,
    deviceId: record.deviceId,
    serverVersion: record.serverVersion,
    accountId: record.accountNamespace,
  }
  if (record.tenantId) config.tenantId = record.tenantId
  if (record.tlsPin) config.serverFingerprint = record.tlsPin
  if (record.endpoints.lanBaseUrl) config.lanBaseUrl = record.endpoints.lanBaseUrl
  if (record.endpoints.tunnelBaseUrl) config.tunnelBaseUrl = record.endpoints.tunnelBaseUrl
  if (record.rendezvousId) config.rendezvousId = record.rendezvousId
  if (record.signalingUrl) config.signalingUrl = record.signalingUrl
  if (record.iceServers) config.iceServers = record.iceServers
  if (record.signalingRoomDescriptor) {
    config.signalingRoomDescriptor = record.signalingRoomDescriptor
    if (credential.signalingPrivateKeyJwk) {
      config.signalingPrivateKeyJwk = credential.signalingPrivateKeyJwk
      config.signalingPrivateKey = await importV2SigningPrivateKey(
        credential.signalingPrivateKeyJwk
      )
    }
  }
  return config
}

export class CredentialBookCompanionStorage implements CompanionConfigStorage {
  constructor(private readonly opts: CredentialBookAdapterOptions) {}

  async load(): Promise<CompanionConfig | null> {
    const record = await this.selectedRecord()
    if (!record) return null
    let credential: CompanionHostCredential | null = null
    try {
      credential = await this.opts.book.loadCredential(hostKeyOf(record))
    } catch {
      // A locked Vault is not "unpaired" — but it also cannot produce a token,
      // and every caller of `load()` needs one. Report absence; Settings still
      // lists the host from the public record.
      return null
    }
    if (!credential) return null
    return toCompanionConfig(record, credential)
  }

  async save(config: CompanionConfig): Promise<void> {
    // Matches the storage this replaced: outside a browser there is nowhere to
    // persist, and the in-memory config cache stays authoritative for the
    // process. Throwing here would break SSR and static-export prerender.
    if (typeof window === "undefined") return
    if (!config.devicePrivateKeyJwk || !config.deviceKeyThumbprint) {
      throw new Error("Companion device identity is missing; pair this device again.")
    }
    const accountNamespace =
      this.opts.accountNamespace() ?? config.accountId ?? DEFAULT_ACCOUNT_NAMESPACE
    const hostId = legacyHostId(config)
    const key = { hostId, accountNamespace }
    const [existing, previousActive] = await Promise.all([
      this.opts.book.get(key),
      this.opts.book.getActive(accountNamespace),
    ])
    const previousCredential = existing ? await this.opts.book.loadCredential(key) : null
    // Secrets land first. If the secure write fails, the public target book is
    // untouched; this prevents a half-paired target whose key is unavailable.
    try {
      await this.opts.book.saveCredential(key, {
        devicePrivateKeyJwk: config.devicePrivateKeyJwk,
        signalingPrivateKeyJwk: config.signalingPrivateKeyJwk,
      })
      await this.opts.book.upsert({
        hostId,
        accountNamespace,
        tenantId: config.tenantId ?? existing?.tenantId ?? config.accountId,
        label: existing?.label ?? legacyLabel(config),
        endpoints: {
          baseUrl: config.baseUrl,
          lanBaseUrl: config.lanBaseUrl,
          tunnelBaseUrl: config.tunnelBaseUrl,
        },
        tlsPin: config.serverFingerprint ?? null,
        deviceId: config.deviceId,
        deviceKeyThumbprint: config.deviceKeyThumbprint,
        serverVersion: config.serverVersion,
        rendezvousId: config.rendezvousId,
        signalingRoomDescriptor: config.signalingRoomDescriptor,
        signalingUrl: config.signalingUrl,
        iceServers: config.iceServers,
      })
      await this.opts.book.setActive(key)
    } catch (error) {
      try {
        // Remove both halves first. `book.remove()` deliberately also deletes
        // a credential when no public record exists, covering failed upserts.
        await this.opts.book.remove(key)
        if (existing) {
          await this.opts.book.upsert(existing)
          if (previousCredential) {
            await this.opts.book.saveCredential(key, previousCredential)
          }
        }
        if (previousActive) await this.opts.book.setActive(hostKeyOf(previousActive))
      } catch (rollbackError) {
        throw new Error(
          `Companion pairing persistence failed and rollback was incomplete: ${errorMessage(rollbackError)}`,
          { cause: error }
        )
      }
      throw error
    }
  }

  /**
   * Forget the account's active pairing.
   *
   * Scoped on purpose: `clear()` has always meant "sign this device out of its
   * desktop", and under a multi-host book that must not become "forget every
   * desktop I have ever paired with".
   */
  async clear(): Promise<void> {
    if (typeof window === "undefined") return
    const record = await this.selectedRecord()
    if (!record) return
    await this.opts.book.remove(hostKeyOf(record))
  }

  async remove(config: CompanionConfig): Promise<void> {
    await this.opts.book.remove({
      accountNamespace: config.accountId ?? this.namespace(),
      hostId: legacyHostId(config),
    })
  }

  private async selectedRecord(): Promise<CompanionHostRecord | null> {
    const accountNamespace = this.namespace()
    const activeHostId = this.opts.activeHostId?.()
    if (activeHostId === null) return null
    if (activeHostId === undefined) return this.opts.book.getActive(accountNamespace)
    return this.opts.book.get({ accountNamespace, hostId: activeHostId })
  }

  /**
   * The account this adapter files under.
   *
   * Falls back to {@link DEFAULT_ACCOUNT_NAMESPACE} rather than refusing: the
   * single-config world had no account concept at all, and a pairing that
   * cannot be filed is a pairing that is lost.
   */
  private namespace(): string {
    return this.opts.accountNamespace() ?? DEFAULT_ACCOUNT_NAMESPACE
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
