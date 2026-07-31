/**
 * Reconcile-state CRUD for Lark chat surfaces — Chat Tabs and group menus
 * (Dexie v126, plan 2026-07-24 Phase 4).
 *
 * One row per (adapterId, chatId, surfaceType) — the compound primary key IS
 * the idempotency key: re-entrant reconciles converge on the same row instead
 * of minting duplicates. `nextAttemptAt` carries the exponential backoff so a
 * failing chat cannot retry-storm the platform API.
 */

import type {
  LarkChatSurfaceRow,
  LarkChatSurfaceStatus,
  LarkChatSurfaceType,
} from "./connector-types"
import { getDb } from "./schema"

const BACKOFF_BASE_MS = 30_000
const BACKOFF_CAP_MS = 60 * 60 * 1000

export function surfaceKey(
  adapterId: string,
  chatId: string,
  surfaceType: LarkChatSurfaceType
): [string, string, string] {
  return [adapterId, chatId, surfaceType]
}

export async function getChatSurface(
  adapterId: string,
  chatId: string,
  surfaceType: LarkChatSurfaceType
): Promise<LarkChatSurfaceRow | undefined> {
  return getDb().larkChatSurfaces.get(surfaceKey(adapterId, chatId, surfaceType))
}

export interface EnsureChatSurfaceInput {
  adapterId: string
  chatId: string
  surfaceType: LarkChatSurfaceType
  urlVersion: number
  desiredUrl?: string
  tenantKey?: string
  appId?: string
  now?: number
}

function unchangedTarget(existing: LarkChatSurfaceRow, input: EnsureChatSurfaceInput): boolean {
  return (
    existing.urlVersion === input.urlVersion &&
    existing.desiredUrl === (input.desiredUrl ?? existing.desiredUrl)
  )
}

/** Create-or-refresh the desired state for one surface (status → pending). */
export async function ensureChatSurface(
  input: EnsureChatSurfaceInput
): Promise<LarkChatSurfaceRow> {
  const now = input.now ?? Date.now()
  const existing = await getChatSurface(input.adapterId, input.chatId, input.surfaceType)
  const row: LarkChatSurfaceRow = existing
    ? {
        ...existing,
        urlVersion: input.urlVersion,
        desiredUrl: input.desiredUrl ?? existing.desiredUrl,
        tenantKey: input.tenantKey ?? existing.tenantKey,
        appId: input.appId ?? existing.appId,
        // A changed layout version or URL re-arms the reconcile loop. A
        // `blocked` row does NOT re-arm on an unchanged target: the platform
        // refusal (missing scope, group-only surface in a p2p chat) survives
        // every retry, so only a new URL — or an explicit resync — clears it.
        status: unchangedTarget(existing, input)
          ? existing.status === "synced" || existing.status === "blocked"
            ? existing.status
            : "pending"
          : "pending",
        updatedAt: now,
      }
    : {
        adapterId: input.adapterId,
        chatId: input.chatId,
        surfaceType: input.surfaceType,
        tenantKey: input.tenantKey,
        appId: input.appId,
        urlVersion: input.urlVersion,
        desiredUrl: input.desiredUrl,
        status: "pending",
        attempt: 0,
        createdAt: now,
        updatedAt: now,
      }
  await getDb().larkChatSurfaces.put(row)
  return row
}

export async function markChatSurfaceSynced(
  adapterId: string,
  chatId: string,
  surfaceType: LarkChatSurfaceType,
  patch: { platformSurfaceId?: string; now?: number } = {}
): Promise<void> {
  const now = patch.now ?? Date.now()
  const existing = await getChatSurface(adapterId, chatId, surfaceType)
  if (!existing) return
  await getDb().larkChatSurfaces.put({
    ...existing,
    status: "synced",
    platformSurfaceId: patch.platformSurfaceId ?? existing.platformSurfaceId,
    attempt: 0,
    nextAttemptAt: undefined,
    lastSyncAt: now,
    lastError: undefined,
    updatedAt: now,
  })
}

/** Record a failed attempt with exponential backoff (2^n·30 s, cap 1 h). */
export async function markChatSurfaceError(
  adapterId: string,
  chatId: string,
  surfaceType: LarkChatSurfaceType,
  error: string,
  now?: number
): Promise<LarkChatSurfaceRow | undefined> {
  const at = now ?? Date.now()
  const existing = await getChatSurface(adapterId, chatId, surfaceType)
  if (!existing) return undefined
  const attempt = existing.attempt + 1
  const backoff = Math.min(BACKOFF_BASE_MS * 2 ** (attempt - 1), BACKOFF_CAP_MS)
  const row: LarkChatSurfaceRow = {
    ...existing,
    status: "error",
    attempt,
    nextAttemptAt: at + backoff,
    lastError: error,
    updatedAt: at,
  }
  await getDb().larkChatSurfaces.put(row)
  return row
}

/**
 * Park a surface the platform will keep refusing. Unlike `markChatSurfaceError`
 * this sets no `nextAttemptAt`, so the sweep skips it until an operator resyncs
 * or the desired URL changes.
 */
export async function markChatSurfaceBlocked(
  adapterId: string,
  chatId: string,
  surfaceType: LarkChatSurfaceType,
  reason: string,
  now?: number
): Promise<LarkChatSurfaceRow | undefined> {
  const at = now ?? Date.now()
  const existing = await getChatSurface(adapterId, chatId, surfaceType)
  if (!existing) return undefined
  const row: LarkChatSurfaceRow = {
    ...existing,
    status: "blocked",
    nextAttemptAt: undefined,
    lastError: reason,
    updatedAt: at,
  }
  await getDb().larkChatSurfaces.put(row)
  return row
}

export async function setChatSurfaceStatus(
  adapterId: string,
  chatId: string,
  surfaceType: LarkChatSurfaceType,
  status: LarkChatSurfaceStatus,
  now?: number
): Promise<void> {
  const existing = await getChatSurface(adapterId, chatId, surfaceType)
  if (!existing) return
  await getDb().larkChatSurfaces.put({
    ...existing,
    status,
    updatedAt: now ?? Date.now(),
  })
}

/**
 * Surfaces due for a reconcile pass: pending / rebuild_required always,
 * errors once their backoff elapsed, plus synced rows stale for > 24 h.
 */
export async function listDueChatSurfaces(
  adapterId: string,
  now?: number
): Promise<LarkChatSurfaceRow[]> {
  const at = now ?? Date.now()
  const rows = await getDb().larkChatSurfaces.where("adapterId").equals(adapterId).toArray()
  return rows.filter((row) => {
    switch (row.status) {
      case "pending":
      case "rebuild_required":
        return true
      case "error":
        return row.nextAttemptAt === undefined || row.nextAttemptAt <= at
      case "synced":
        return (row.lastSyncAt ?? 0) < at - 24 * 60 * 60 * 1000
      // Terminal until an operator acts: retrying either changes nothing
      // (blocked) or would re-create something deliberately taken down.
      case "blocked":
      case "removed":
        return false
    }
  })
}

export async function listChatSurfaces(adapterId: string): Promise<LarkChatSurfaceRow[]> {
  return getDb().larkChatSurfaces.where("adapterId").equals(adapterId).toArray()
}
