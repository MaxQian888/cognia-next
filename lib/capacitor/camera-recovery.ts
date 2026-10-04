"use client"

import { subscribeRestoredResult, type RestoredAppResult } from "./app"

export interface CameraRecoveryTarget {
  kind: "chat" | "twin"
  id: string
}

export type CameraRecoveryResult =
  | { kind: "photo"; photo: { base64?: string; uri?: string; format: string } }
  | { kind: "photos"; photos: Array<{ uri: string; format: string }> }
  | { kind: "error" }

interface Receipt {
  id: string
  scope: string
  target: CameraRecoveryTarget
  method: "getPhoto" | "pickImages"
  limit: number
  createdAt: number
  result?: CameraRecoveryResult
}

// Only native file URIs and routing metadata are stored here. Image bytes stay
// in the Camera plugin's cache until the normal attachment intake reads them.
// This inbox must be accessible before AccountGate opens the account database.
const KEY = "cognia.camera-recovery.v1"
const MAX_AGE = 24 * 60 * 60 * 1000
const subscribers = new Set<() => void>()
const delivering = new Set<string>()
let activeCall: string | undefined
let startup: Promise<void> | undefined

function read(): Receipt[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(KEY) ?? "[]")
    if (!Array.isArray(value)) return []
    return value.filter(
      (r): r is Receipt =>
        typeof r?.id === "string" &&
        typeof r.scope === "string" &&
        (r.target?.kind === "chat" || r.target?.kind === "twin") &&
        typeof r.target.id === "string" &&
        (r.method === "getPhoto" || r.method === "pickImages") &&
        typeof r.createdAt === "number" &&
        Date.now() - r.createdAt < MAX_AGE
    )
  } catch {
    return []
  }
}

function write(receipts: Receipt[]): void {
  if (receipts.length) localStorage.setItem(KEY, JSON.stringify(receipts))
  else localStorage.removeItem(KEY)
}

function remove(id: string): void {
  write(read().filter((r) => r.id !== id))
}

async function scope(): Promise<string> {
  const { getDb } = await import("@/lib/db/schema")
  return getDb().name
}

/** One app-lifetime listener, registered above AccountGate and before launch. */
export function startCameraRecovery(): Promise<void> {
  startup ??= subscribeRestoredResult(handleRestoredCameraResult)
    .then(() => undefined)
    .catch((error) => {
      startup = undefined
      throw error
    })
  return startup
}

/** Persist the destination BEFORE launching an external Android activity. */
export async function beginCameraRecovery(
  target: CameraRecoveryTarget | undefined,
  method: Receipt["method"],
  limit = 9
): Promise<() => void> {
  if (activeCall) throw new Error("A camera operation is already in progress")
  const id = crypto.randomUUID()
  activeCall = id
  try {
    if (target) {
      await startCameraRecovery()
      const database = await scope()
      write([
        ...read().filter((r) => r.result),
        { id, scope: database, target, method, limit, createdAt: Date.now() },
      ])
    } else {
      // An unscoped workflow must never inherit an old chat destination.
      write(read().filter((r) => r.result))
    }
  } catch (error) {
    if (activeCall === id) activeCall = undefined
    throw error
  }
  return () => {
    if (activeCall === id) activeCall = undefined
    try {
      remove(id)
    } catch {
      /* A bridge result must not reject during cleanup. */
    }
  }
}

function photo(value: unknown): { uri: string; format: string } | undefined {
  if (!value || typeof value !== "object") return undefined
  const data = value as Record<string, unknown>
  if (typeof data.webPath !== "string" || !data.webPath || typeof data.format !== "string")
    return undefined
  return { uri: data.webPath, format: data.format }
}

export function handleRestoredCameraResult(event: RestoredAppResult): void {
  if (event.pluginId !== "Camera") return
  const receipts = read()
  const receipt = receipts.find((r) => !r.result && r.method === event.methodName)
  if (!receipt) return
  if (activeCall === receipt.id) activeCall = undefined
  const data = event.data as { photos?: unknown[] } | undefined
  const single = event.success && receipt.method === "getPhoto" ? photo(event.data) : undefined
  const photos =
    event.success && receipt.method === "pickImages" && Array.isArray(data?.photos)
      ? data.photos.map(photo).filter((p): p is { uri: string; format: string } => !!p)
      : []
  if (single) receipt.result = { kind: "photo", photo: single }
  else if (photos.length)
    receipt.result = {
      kind: "photos",
      photos: receipt.limit > 0 ? photos.slice(0, receipt.limit) : photos,
    }
  else if (!event.success && /cancel/i.test(event.error?.message ?? "")) {
    remove(receipt.id)
    return
  } else receipt.result = { kind: "error" }
  write(receipts)
  for (const notify of subscribers) notify()
}

/** Delivery is scoped to the originating account/host database and destination. */
export function subscribeCameraRecovery(
  target: CameraRecoveryTarget,
  handler: (result: CameraRecoveryResult, isCurrent: () => boolean) => Promise<boolean>
): () => void {
  let disposed = false
  const drain = async () => {
    if (!read().some((r) => r.result && r.target.kind === target.kind && r.target.id === target.id))
      return
    const { getDb } = await import("@/lib/db/schema")
    const database = getDb().name
    for (const receipt of read()) {
      if (
        disposed ||
        !receipt.result ||
        receipt.scope !== database ||
        receipt.target.kind !== target.kind ||
        receipt.target.id !== target.id ||
        delivering.has(receipt.id)
      )
        continue
      // Scope can change while a previous delivery was awaiting its consumer.
      if (getDb().name !== database || disposed) return
      delivering.add(receipt.id)
      const isCurrent = () => !disposed && getDb().name === database
      try {
        if (await handler(receipt.result, isCurrent)) remove(receipt.id)
      } finally {
        delivering.delete(receipt.id)
        // A replacement mount may have skipped this claimed receipt while the
        // old consumer was still reading its URI. Wake it when that claim ends.
        // A current consumer's refusal must not cause an endless retry loop.
        if (!isCurrent()) for (const notify of subscribers) notify()
      }
    }
  }
  const notify = () => {
    void drain().catch(() => undefined)
  }
  subscribers.add(notify)
  notify()
  return () => {
    disposed = true
    subscribers.delete(notify)
  }
}
