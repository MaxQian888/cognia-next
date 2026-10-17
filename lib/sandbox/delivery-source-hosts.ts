/** Pins cleanup to the original authenticated Host before source admission. */
import type { ChatSession } from "@cognia/agent-config-types"
import { getActiveRemoteEndpoint, getActiveRemoteTransport } from "@/lib/tauri/transport-routing"
import { localTransport, transport, onTransportChange } from "@/lib/tauri/transport-instance"
import { isTauri } from "@/lib/utils"
import { isHeadlessHost } from "@/lib/platform/detect"
import { useAccountStore } from "@/stores/account/account-store"
import { getDb } from "@/lib/db/schema"

type SourceHost = NonNullable<ChatSession["deliverySourceHosts"]>[number]

function captureTarget() {
  const remote = getActiveRemoteTransport()
  const endpoint = getActiveRemoteEndpoint()
  const local = isTauri() ? localTransport : transport
  if (!remote && !isTauri() && !isHeadlessHost())
    throw new Error("delivery_source_host_identity_missing")
  if (remote && !endpoint) throw new Error("delivery_source_host_identity_missing")
  const endpointIdentity =
    remote && endpoint
      ? JSON.stringify([
          endpoint.baseUrl,
          endpoint.serverFingerprint,
          endpoint.deviceId,
          endpoint.deviceKeyThumbprint,
        ])
      : undefined
  const assertCurrent = () => {
    const current = getActiveRemoteEndpoint()
    const identity = current
      ? JSON.stringify([
          current.baseUrl,
          current.serverFingerprint,
          current.deviceId,
          current.deviceKeyThumbprint,
        ])
      : undefined
    if (
      getActiveRemoteTransport() !== remote ||
      (!remote && !isTauri() && transport !== local) ||
      (remote && identity !== endpointIdentity)
    )
      throw new Error("delivery_source_host_changed")
  }
  return {
    kind: remote ? ("remote" as const) : ("local" as const),
    endpointIdentity,
    assertCurrent,
    async call<T>(name: string, args: Record<string, unknown>): Promise<T> {
      assertCurrent()
      const result = remote
        ? await remote.call<T>(name, args)
        : isTauri()
          ? await localTransport.call<T>("managed_desktop_local_call", { name, args })
          : await local.call<T>(name, args)
      assertCurrent()
      return result
    },
  }
}

/** A durable cleanup barrier precedes the first possible delivery on this Host. */
export async function recordDeliverySourceHost(conversationId: string): Promise<() => void> {
  const target = captureTarget()
  const db = getDb()
  const account = useAccountStore.getState()
  const owner = account.unlockedAccountId
  const locked = account.locked
  let invalidated = false
  const detachAccount = useAccountStore.subscribe(() => {
    const current = useAccountStore.getState()
    if (current.unlockedAccountId !== owner || current.locked !== locked) invalidated = true
  })
  const detachTransport = onTransportChange(() => {
    invalidated = true
  })
  const assertActive = () => {
    target.assertCurrent()
    const current = useAccountStore.getState()
    if (
      invalidated ||
      getDb() !== db ||
      current.unlockedAccountId !== owner ||
      current.locked !== locked
    )
      throw new Error("delivery_source_owner_changed")
  }
  try {
    const identity = await target.call<{ hostId: string }>(
      "managed_desktop_handoff_source_host",
      {}
    )
    assertActive()
    if (!identity.hostId) throw new Error("delivery_source_host_identity_missing")
    const { recordSessionDeliverySourceHost } = await import("@/lib/db/sessions")
    assertActive()
    const entry: SourceHost = {
      kind: target.kind,
      hostId: identity.hostId,
      ...(target.endpointIdentity ? { endpointIdentity: target.endpointIdentity } : {}),
    }
    await recordSessionDeliverySourceHost(conversationId, entry, { db, assertActive })
    assertActive()
    return assertActive
  } finally {
    detachAccount()
    detachTransport()
  }
}

/** Canonical deletion awaits revocation before losing durable source ownership. */
export async function revokeDeliverySourceHosts(
  rows: readonly (Pick<ChatSession, "id" | "deliverySourceHosts"> | undefined)[],
  assertPersistenceActive: () => void = () => undefined,
  onRevoked?: (conversationId: string, remaining: SourceHost[]) => Promise<void>
): Promise<void> {
  if (!rows.some((row) => row?.deliverySourceHosts?.length)) return
  const account = useAccountStore.getState()
  let invalidated = false
  const detachAccount = useAccountStore.subscribe(() => {
    const current = useAccountStore.getState()
    if (
      current.unlockedAccountId !== account.unlockedAccountId ||
      current.locked !== account.locked
    )
      invalidated = true
  })
  const assertActive = () => {
    assertPersistenceActive()
    const current = useAccountStore.getState()
    if (
      invalidated ||
      current.unlockedAccountId !== account.unlockedAccountId ||
      current.locked !== account.locked
    )
      throw new Error("delivery_source_owner_changed")
  }
  try {
    for (const row of rows) {
      if (!row?.deliverySourceHosts?.length) continue
      let remaining = [...row.deliverySourceHosts]
      for (const recorded of row.deliverySourceHosts) {
        assertActive()
        const target = captureTarget()
        if (target.kind !== recorded.kind || target.endpointIdentity !== recorded.endpointIdentity)
          throw new Error("delivery_source_original_host_required")
        const actual = await target.call<{ hostId: string }>(
          "managed_desktop_handoff_source_host",
          {}
        )
        assertActive()
        if (actual.hostId !== recorded.hostId)
          throw new Error("delivery_source_original_host_required")
        await target.call("managed_desktop_handoff_revoke_source", { conversationIds: [row.id] })
        assertActive()
        remaining = remaining.filter((host) => host !== recorded)
        // A conversation may have used several Hosts. Persist successful revokes
        // so a retry can select the next Host without reviving previous sources.
        await onRevoked?.(row.id, remaining)
        assertActive()
      }
    }
  } finally {
    detachAccount()
  }
}
