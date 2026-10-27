// Secondary pet windows have no unlocked account database. Project only the
// displayed model over a local, in-memory channel; never share account keys.
import { z } from "zod"
import type { PetModelRow } from "@/lib/db/pet-models"
import type { Live2dSkinAsset } from "@/lib/pet/skin-assets"
import { getPetSkinRuntime } from "@/lib/pet/skin-runtime"
import { getPetWindowRole } from "@/lib/pet/window-role"
import { MAX_MODEL_BYTES } from "./constants"

const CHANNEL = "cognia:pet:live2d-assets:v1"
const rowSchema: z.ZodType<PetModelRow> = z.object({
  id: z.string().min(1).max(128),
  name: z.string().max(1024),
  source: z.enum(["import", "sample"]),
  settingsPath: z.string().min(1).max(1024),
  motionGroups: z.array(z.string().max(1024)).max(2000),
  expressionIds: z.array(z.string().max(1024)).max(2000),
  totalBytes: z.number().nonnegative().max(MAX_MODEL_BYTES),
  createdAt: z.number().nonnegative(),
  transform: z.object({ scale: z.number(), offsetX: z.number(), offsetY: z.number() }).optional(),
  motionOverrides: z
    .record(
      z.string(),
      z.object({
        motionGroup: z.string().optional(),
        motionIndex: z.number().int().nonnegative().optional(),
        expressionId: z.string().optional(),
      })
    )
    .optional(),
  parameterMapping: z
    .object(
      Object.fromEntries(
        ["headX", "headY", "headZ", "eyeX", "eyeY", "bodyX", "bodyY", "mouthOpen"].map((role) => [
          role,
          z.string().nullable().optional(),
        ])
      )
    )
    .optional(),
})

export interface AssetChannel {
  onmessage: ((event: { data: unknown }) => void) | null
  postMessage(value: unknown): void
  close(): void
}

function channel(): AssetChannel | undefined {
  if (typeof BroadcastChannel === "undefined") return undefined
  const wire = new BroadcastChannel(CHANNEL)
  const adapter: AssetChannel = {
    onmessage: null,
    postMessage: (value) => wire.postMessage(value),
    close: () => wire.close(),
  }
  wire.onmessage = (event) => adapter.onmessage?.({ data: event.data })
  return adapter
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object"
}

function decodeRow(value: unknown): PetModelRow | undefined {
  if (!record(value)) return undefined
  try {
    if (JSON.stringify(value).length > 128 * 1024) return undefined
    const parsed = rowSchema.safeParse(value)
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

function decodeEntries(value: unknown): Live2dSkinAsset["entries"] | undefined {
  if (!Array.isArray(value) || value.length > 2000) return undefined
  let bytes = 0
  for (const entry of value) {
    if (
      !record(entry) ||
      typeof entry.path !== "string" ||
      !entry.path ||
      entry.path.length > 1024 ||
      entry.path.startsWith("/") ||
      entry.path.includes("\\") ||
      entry.path.split("/").includes("..") ||
      !(entry.blob instanceof Blob)
    )
      return undefined
    bytes += entry.blob.size
    if (bytes > MAX_MODEL_BYTES) return undefined
  }
  return value as Live2dSkinAsset["entries"]
}

export function isLive2dAssetMirror(): boolean {
  const role = getPetWindowRole()
  return role === "overlay" || role === "popup"
}

interface ResponderDeps {
  channel?: AssetChannel
  selectedModel: () => string | undefined
  readAsset: (id: string) => Promise<Live2dSkinAsset | undefined>
  watchRow: (id: string, next: (row: PetModelRow | undefined) => void) => () => void
}

export function startMainLive2dAssets(deps: ResponderDeps) {
  const wire = deps.channel ?? channel()
  let disposed = false
  let modelId: string | undefined
  let session = ""
  let row: PetModelRow | undefined
  let rowObserved = false
  let unwatch: (() => void) | undefined
  const seenRequests = new Set<string>()
  const post = (message: Record<string, unknown>) => wire?.postMessage({ v: 1, ...message })
  const revoke = () => {
    seenRequests.clear()
    unwatch?.()
    unwatch = undefined
    if (modelId) {
      getPetSkinRuntime().invalidateAsset(`live2d:${modelId}`)
      post({ t: "revoke", session, modelId })
    }
    modelId = undefined
    row = undefined
    rowObserved = false
  }
  const sync = () => {
    if (disposed || !wire) return
    const next = deps.selectedModel()
    if (next === modelId) return
    revoke()
    modelId = next
    if (next) {
      session = crypto.randomUUID()
      const current = session
      unwatch = deps.watchRow(next, (value) => {
        if (disposed || current !== session || deps.selectedModel() !== next) return
        rowObserved = true
        row = decodeRow(value)
        if (!row) getPetSkinRuntime().invalidateAsset(`live2d:${next}`)
        post({ t: "metadata", session, modelId: next, row: row ?? null })
      })
    }
    post({ t: "ready" })
  }
  if (wire)
    wire.onmessage = (event) => {
      const msg = event.data
      if (!record(msg) || msg.v !== 1) return
      if (msg.t === "hello") {
        sync()
        if (modelId && row) post({ t: "metadata", session, modelId, row })
        return
      }
      if (
        msg.t !== "request" ||
        typeof msg.requestId !== "string" ||
        msg.requestId.length > 128 ||
        typeof msg.modelId !== "string"
      )
        return
      sync()
      if (!modelId || msg.modelId !== modelId || deps.selectedModel() !== modelId) return
      if (seenRequests.has(msg.requestId)) return
      seenRequests.add(msg.requestId)
      if (seenRequests.size > 128) seenRequests.delete(seenRequests.values().next().value!)
      const id = modelId,
        current = session
      void deps
        .readAsset(id)
        .then((asset) => {
          if (disposed || session !== current || deps.selectedModel() !== id) return
          const metadata = rowObserved ? row : decodeRow(asset?.row)
          const entries = decodeEntries(asset?.entries)
          post({
            t: "asset",
            session,
            modelId: id,
            requestId: msg.requestId,
            row: entries ? (metadata ?? null) : null,
            entries: entries ?? [],
          })
        })
        .catch(() => {
          if (!disposed && session === current && deps.selectedModel() === id)
            post({
              t: "asset",
              session,
              modelId: id,
              requestId: msg.requestId,
              row: null,
              entries: [],
            })
        })
    }
  sync()
  post({ t: "ready" })
  return {
    sync,
    dispose: () => {
      if (disposed) return
      disposed = true
      revoke()
      if (wire) {
        wire.onmessage = null
        wire.close()
      }
    },
  }
}

export class Live2dAssetMirror {
  readonly rows = new Map<string, PetModelRow>()
  private sessions = new Map<string, string>()
  private revoked = new Set<string>()
  private retryIds = new Set<string>()
  private listeners = new Set<() => void>()
  private pending = new Map<
    string,
    { id: string; finish: (asset: Live2dSkinAsset | undefined) => void }
  >()
  private disposed = false
  constructor(
    private readonly wire: AssetChannel | undefined = channel(),
    private readonly timeoutMs = 10_000
  ) {
    if (wire) {
      wire.onmessage = (event) => this.receive(event.data)
      wire.postMessage({ v: 1, t: "hello" })
    }
  }
  private emit() {
    for (const listener of this.listeners) listener()
  }
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  request(id: string): Promise<Live2dSkinAsset | undefined> {
    if (!this.wire || this.disposed) return Promise.resolve(undefined)
    const requestId = crypto.randomUUID()
    return new Promise((resolve) => {
      const timer = setTimeout(() => finish(undefined), this.timeoutMs)
      const finish = (asset: Live2dSkinAsset | undefined) => {
        clearTimeout(timer)
        this.pending.delete(requestId)
        if (!asset) this.retryIds.add(id)
        resolve(asset)
      }
      this.pending.set(requestId, { id, finish })
      this.wire!.postMessage({ v: 1, t: "request", requestId, modelId: id })
    })
  }
  private receive(value: unknown) {
    if (this.disposed || !record(value) || value.v !== 1) return
    if (value.t === "ready") {
      this.wire?.postMessage({ v: 1, t: "hello" })
      for (const [requestId, pending] of this.pending)
        this.wire?.postMessage({ v: 1, t: "request", requestId, modelId: pending.id })
      return
    }
    if (typeof value.session !== "string" || typeof value.modelId !== "string") return
    const id = value.modelId,
      session = value.session
    if (value.t === "revoke") {
      this.revoked.add(session)
      // Request ids also fence late replies; bound the remembered epochs.
      if (this.revoked.size > 64) this.revoked.delete(this.revoked.values().next().value!)
      if (!this.sessions.has(id) || this.sessions.get(id) === session) {
        this.rows.delete(id)
        this.sessions.delete(id)
        this.retryIds.add(id)
        getPetSkinRuntime().invalidateAsset(`live2d:${id}`)
        for (const pending of [...this.pending.values()])
          if (pending.id === id) pending.finish(undefined)
        this.emit()
      }
      return
    }
    if (this.revoked.has(session)) return
    const pending =
      typeof value.requestId === "string" ? this.pending.get(value.requestId) : undefined
    if (value.t !== "metadata" && (value.t !== "asset" || pending?.id !== id)) return
    const row = decodeRow(value.row)
    if (row?.id !== id && value.row !== null) {
      pending?.finish(undefined)
      return
    }
    const previousSession = this.sessions.get(id)
    const changedSession = previousSession !== undefined && previousSession !== session
    // Only main's metadata establishes a replacement epoch. A late file reply
    // cannot replace the current account's metadata or reuse its cached bytes.
    if (changedSession && value.t === "asset") return
    if (changedSession) {
      this.revoked.add(previousSession)
      if (this.revoked.size > 64) this.revoked.delete(this.revoked.values().next().value!)
      for (const request of [...this.pending.values()])
        if (request.id === id) request.finish(undefined)
    }
    this.sessions.set(id, session)
    if (row?.id !== id) {
      if (value.row === null) {
        this.rows.delete(id)
        this.retryIds.add(id)
        if (changedSession) getPetSkinRuntime().retryAsset(`live2d:${id}`)
        else getPetSkinRuntime().invalidateAsset(`live2d:${id}`)
        this.emit()
      }
      pending?.finish(undefined)
      return
    }
    this.rows.set(id, row)
    const retry = this.retryIds.delete(id)
    if (changedSession || retry || getPetSkinRuntime().assetDiagnostic(`live2d:${id}`))
      getPetSkinRuntime().retryAsset(`live2d:${id}`)
    this.emit()
    if (value.t === "asset") {
      const entries = decodeEntries(value.entries)
      pending?.finish(entries ? { row, entries } : undefined)
    }
  }
  dispose() {
    this.disposed = true
    for (const pending of [...this.pending.values()]) pending.finish(undefined)
    for (const id of this.rows.keys()) getPetSkinRuntime().invalidateAsset(`live2d:${id}`)
    this.rows.clear()
    this.listeners.clear()
    this.sessions.clear()
    if (this.wire) {
      this.wire.onmessage = null
      this.wire.close()
    }
  }
}

let mirror: Live2dAssetMirror | undefined
let subscribers = 0
export function subscribeLive2dMirror(listener: () => void): () => void {
  if (!isLive2dAssetMirror()) return () => {}
  mirror ??= new Live2dAssetMirror()
  subscribers += 1
  const current = mirror
  const unsubscribe = current.subscribe(listener)
  return () => {
    unsubscribe()
    subscribers -= 1
    queueMicrotask(() => {
      if (subscribers === 0 && mirror === current) {
        current.dispose()
        mirror = undefined
      }
    })
  }
}
export function getMirroredLive2dRow(id: string): PetModelRow | undefined {
  return mirror?.rows.get(id)
}
export function requestMirroredLive2dAsset(id: string) {
  mirror ??= new Live2dAssetMirror()
  return mirror.request(id)
}
