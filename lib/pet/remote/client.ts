// The paired device's typed calls for remote pet care (ADR-0219).
//
// Every call goes straight over the companion transport, live. None of these
// is part of `MOBILE_OUTBOUND_COMMANDS`, on purpose: a feed queued offline and
// replayed an hour later would be priced against a cooldown, a mood and a coin
// balance that no longer exist. A call that cannot reach the host fails, and
// the UI says so.
//
// Each write mints ONE idempotency key per user intent and sends it in
// the body (where accepted, for the host's device-scoped `pet_*` ledger) and
// as a UUID transport option (the companion server's own header ledger), so a
// retry after a lost reply, over any channel, folds onto the first answer.

import type { Transport } from "@/lib/tauri/transport-types"
import { sha256Hex } from "@/lib/share/hash"
import { PET_REMOTE_COMMANDS } from "./commands"
import type {
  PetActResult,
  PetApplyResult,
  PetChatClearResult,
  PetChatListResult,
  PetChatLocale,
  PetChatSendResult,
  PetHatchResult,
  PetPurchaseResult,
  PetRemoteSnapshot,
  PetRenameResult,
} from "./types"
import { isPetRemoteSnapshot } from "./types"
import type { PetInteractionKind } from "@/lib/pet/access/limits"

/** A fresh key for one user intent. Reuse it only to retry that same intent. */
export function newPetIntentKey(): string {
  const cryptoApi = globalThis.crypto
  if (cryptoApi && typeof cryptoApi.randomUUID === "function") return cryptoApi.randomUUID()
  // Older WebViews without `randomUUID`: a UUID v4 from the CSPRNG.
  if (cryptoApi && typeof cryptoApi.getRandomValues === "function") {
    const bytes = cryptoApi.getRandomValues(new Uint8Array(16))
    bytes[6] = (bytes[6] & 0x0f) | 0x40
    bytes[8] = (bytes[8] & 0x3f) | 0x80
    const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  }
  throw new Error("no secure random source for a pet intent key")
}

export class PetRemoteSnapshotError extends Error {
  constructor() {
    super("host answered pet_get with something that is not a pet snapshot")
    this.name = "PetRemoteSnapshotError"
  }
}

export interface PetRemoteClient {
  getSnapshot(): Promise<PetRemoteSnapshot>
  act(
    action: PetInteractionKind,
    opts?: { itemId?: string; idempotencyKey?: string }
  ): Promise<PetActResult>
  purchase(
    itemId: string,
    qty: number,
    opts?: { idempotencyKey?: string }
  ): Promise<PetPurchaseResult>
  applyDecor(itemId: string): Promise<PetApplyResult>
  rename(name: string): Promise<PetRenameResult>
  hatch(): Promise<PetHatchResult>
  sendChat(
    text: string,
    locale: PetChatLocale,
    opts?: { idempotencyKey?: string }
  ): Promise<PetChatSendResult>
  listChat(opts?: { pageSize?: number; pageToken?: string }): Promise<PetChatListResult>
  clearChat(): Promise<PetChatClearResult>
}

/**
 * Bind the calls to a transport. Callers pass the companion transport the
 * shell already routes through (`@/lib/tauri/transport-instance`); tests pass
 * a stub.
 */
export function createPetRemoteClient(
  transport: Transport,
  deps: { newKey?: () => string } = {}
): PetRemoteClient {
  const newKey = deps.newKey ?? newPetIntentKey
  const write = async <T>(
    command: string,
    args: Record<string, unknown>,
    key: string
  ): Promise<T> => {
    let transportKey = key
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(key)) {
      // Caller-held body keys may be arbitrary. A stable UUID v8 keeps retries
      // on the same companion ledger entry without changing the host's key.
      const hex = await sha256Hex(`cognia:pet-intent:${key}`)
      transportKey = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`
    }
    return transport.call<T>(command, args, { idempotencyKey: transportKey })
  }

  return {
    async getSnapshot() {
      const snapshot = await transport.call<unknown>(PET_REMOTE_COMMANDS.get, {})
      if (!isPetRemoteSnapshot(snapshot)) throw new PetRemoteSnapshotError()
      return snapshot
    },
    act(action, opts = {}) {
      const idempotencyKey = opts.idempotencyKey ?? newKey()
      return write<PetActResult>(
        PET_REMOTE_COMMANDS.act,
        { action, ...(opts.itemId ? { itemId: opts.itemId } : {}), idempotencyKey },
        idempotencyKey
      )
    },
    purchase(itemId, qty, opts = {}) {
      const idempotencyKey = opts.idempotencyKey ?? newKey()
      return write<PetPurchaseResult>(
        PET_REMOTE_COMMANDS.itemPurchase,
        { itemId, qty, idempotencyKey },
        idempotencyKey
      )
    },
    applyDecor(itemId) {
      return write<PetApplyResult>(PET_REMOTE_COMMANDS.itemApply, { itemId }, newKey())
    },
    rename(name) {
      return write<PetRenameResult>(PET_REMOTE_COMMANDS.rename, { name }, newKey())
    },
    hatch() {
      return write<PetHatchResult>(PET_REMOTE_COMMANDS.soulGenerate, {}, newKey())
    },
    sendChat(text, locale, opts = {}) {
      const idempotencyKey = opts.idempotencyKey ?? newKey()
      return write<PetChatSendResult>(
        PET_REMOTE_COMMANDS.chatSend,
        { text, locale, idempotencyKey },
        idempotencyKey
      )
    },
    listChat(opts = {}) {
      return transport.call<PetChatListResult>(PET_REMOTE_COMMANDS.chatList, {
        ...(opts.pageSize !== undefined ? { pageSize: opts.pageSize } : {}),
        ...(opts.pageToken !== undefined ? { pageToken: opts.pageToken } : {}),
      })
    },
    clearChat() {
      return write<PetChatClearResult>(PET_REMOTE_COMMANDS.chatClear, {}, newKey())
    },
  }
}
