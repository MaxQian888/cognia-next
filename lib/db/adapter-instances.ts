/**
 * CRUD layer for the `adapterInstances` Dexie table (schema v18).
 *
 * One row per configured adapter instance (one Telegram bot, one Discord
 * guild connection, etc.). Rows are keyed by a generated id; the `type`
 * and `enabled` columns are indexed for the bus boot list.
 */

import type { AdapterInstanceRow } from "./connector-types"
import type { PlatformKind } from "@/types/connectors/platform-kind"
import type { TransportMode } from "@/types/connectors/adapter"
import type { TriggerPolicy, ConnectorMode } from "@/types/connectors/policy"
import { getDb } from "./schema"

function newId(): string {
  return "cai_" + Date.now().toString(36) + "_" + Math.random().toString(36).slice(2, 8)
}

export type AdapterInstanceInput = Omit<AdapterInstanceRow, "id" | "createdAt" | "updatedAt">

export async function createAdapterInstance(
  input: AdapterInstanceInput
): Promise<AdapterInstanceRow> {
  const now = Date.now()
  const row: AdapterInstanceRow = {
    id: newId(),
    ...input,
    createdAt: now,
    updatedAt: now,
  }
  await getDb().adapterInstances.add(row)
  return row
}

export async function getAdapterInstance(id: string): Promise<AdapterInstanceRow | undefined> {
  return getDb().adapterInstances.get(id)
}

export async function listAdapterInstances(): Promise<AdapterInstanceRow[]> {
  return getDb().adapterInstances.orderBy("displayName").toArray()
}

export async function listEnabledAdapterInstances(): Promise<AdapterInstanceRow[]> {
  return getDb()
    .adapterInstances.filter((r) => r.enabled)
    .toArray()
}

export async function listAdapterInstancesByType(
  type: PlatformKind
): Promise<AdapterInstanceRow[]> {
  return getDb().adapterInstances.where("type").equals(type).toArray()
}

export async function updateAdapterInstance(
  id: string,
  patch: Partial<
    Pick<
      AdapterInstanceRow,
      | "displayName"
      | "enabled"
      | "transportMode"
      | "settings"
      | "credentialsRef"
      | "trigger"
      | "defaultCharacterId"
      | "defaultMode"
      | "webhookPath"
      | "publicUrl"
      | "quietHours"
      | "muted"
    >
  >
): Promise<void> {
  await getDb().adapterInstances.update(id, { ...patch, updatedAt: Date.now() })
}

export async function deleteAdapterInstance(id: string): Promise<void> {
  await getDb().adapterInstances.delete(id)
}
