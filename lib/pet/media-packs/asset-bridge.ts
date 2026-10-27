import { getPetMediaPack } from "@/lib/db/pet-media-packs"
import { getPetSkinRuntime } from "@/lib/pet/skin-runtime"
import { getPetWindowRole } from "@/lib/pet/window-role"
import { validateMediaAsset, type MediaPackAsset } from "./manifest"

export interface MediaChannel {
  onmessage: ((event: { data: unknown }) => void) | null
  postMessage(data: unknown): void
  close(): void
}
function openChannel(): MediaChannel | undefined {
  if (typeof BroadcastChannel === "undefined") return undefined
  const channel = new BroadcastChannel("cognia:pet:media-assets:v1")
  const wire: MediaChannel = {
    onmessage: null,
    postMessage: (data) => channel.postMessage(data),
    close: () => channel.close(),
  }
  channel.onmessage = (event) => wire.onmessage?.({ data: event.data })
  return wire
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object"
}

/** Main alone reads account storage. The selected, immutable pack is projected in memory. */
export function startMainMediaAssets(deps: {
  selectedPack(): string | undefined
  readPack?: typeof getPetMediaPack
  channel?: MediaChannel
}) {
  const wire = deps.channel ?? openChannel()
  let disposed = false,
    id: string | undefined,
    session = ""
  const seen = new Set<string>()
  const post = (value: Record<string, unknown>) => wire?.postMessage({ v: 1, ...value })
  const revoke = () => {
    if (id) {
      getPetSkinRuntime().invalidateAsset(`media:${id}`)
      post({ t: "revoke", id, session })
    }
    id = undefined
    seen.clear()
  }
  const sync = () => {
    if (disposed || !wire) return
    const next = deps.selectedPack()
    if (next === id) return
    revoke()
    id = next
    session = crypto.randomUUID()
    post({ t: "ready", session, id })
  }
  if (wire)
    wire.onmessage = (event) => {
      const msg = event.data
      if (!record(msg) || msg.v !== 1 || disposed) return
      sync()
      if (msg.t === "hello") {
        post({ t: "ready", session, id })
        return
      }
      if (
        msg.t !== "request" ||
        !id ||
        msg.id !== id ||
        typeof msg.requestId !== "string" ||
        !msg.requestId ||
        msg.requestId.length > 128 ||
        seen.has(msg.requestId)
      )
        return
      seen.add(msg.requestId)
      if (seen.size > 64) seen.delete(seen.values().next().value!)
      const currentId = id,
        currentSession = session
      void (deps.readPack ?? getPetMediaPack)(id)
        .then((asset) => {
          if (!disposed && currentSession === session && deps.selectedPack() === currentId)
            post({
              t: "asset",
              session,
              id: currentId,
              requestId: msg.requestId,
              asset: asset && validateMediaAsset(asset) ? asset : null,
            })
        })
        .catch(() => {
          if (!disposed && currentSession === session && deps.selectedPack() === currentId)
            post({ t: "asset", session, id: currentId, requestId: msg.requestId, asset: null })
        })
    }
  sync()
  post({ t: "ready", session, id })
  return {
    sync,
    dispose() {
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

export class MediaAssetClient {
  private pending = new Map<
    string,
    { id: string; finish(value: MediaPackAsset | undefined): void }
  >()
  private session: string | undefined
  private ids = new Set<string>()
  private failedIds = new Set<string>()
  private retiredSessions = new Set<string>()
  private disposed = false
  constructor(
    private wire = openChannel(),
    private timeoutMs = 15_000
  ) {
    if (wire) {
      wire.onmessage = (event) => this.receive(event.data)
      wire.postMessage({ v: 1, t: "hello" })
    }
  }
  request(id: string): Promise<MediaPackAsset | undefined> {
    if (!this.wire || this.disposed) return Promise.resolve(undefined)
    const requestId = crypto.randomUUID()
    return new Promise((resolve) => {
      const finish = (value: MediaPackAsset | undefined) => {
        clearTimeout(timer)
        this.pending.delete(requestId)
        if (value) this.failedIds.delete(id)
        else this.failedIds.add(id)
        resolve(value)
      }
      const timer = setTimeout(() => finish(undefined), this.timeoutMs)
      this.pending.set(requestId, { id, finish })
      this.wire!.postMessage({ v: 1, t: "request", id, requestId })
    })
  }
  private receive(value: unknown) {
    if (
      this.disposed ||
      !record(value) ||
      value.v !== 1 ||
      typeof value.session !== "string" ||
      !value.session ||
      this.retiredSessions.has(value.session)
    )
      return
    const runtime = getPetSkinRuntime()
    if (value.t === "ready") {
      const replacement = this.session !== undefined && this.session !== value.session
      if (replacement) this.retiredSessions.add(this.session!)
      this.session = value.session
      if (replacement) {
        for (const request of [...this.pending.values()]) {
          this.ids.add(request.id)
          request.finish(undefined)
        }
        for (const id of this.ids) this.failedIds.add(id)
        this.ids.clear()
      }
      for (const id of this.failedIds) runtime.retryAsset(`media:${id}`)
      this.failedIds.clear()
      for (const [requestId, request] of this.pending)
        this.wire?.postMessage({ v: 1, t: "request", id: request.id, requestId })
      return
    }
    if (this.session !== undefined && value.session !== this.session) return
    if (value.t === "revoke" && typeof value.id === "string") {
      this.retiredSessions.add(value.session)
      runtime.invalidateAsset(`media:${value.id}`)
      this.ids.add(value.id)
      for (const request of [...this.pending.values()])
        if (request.id === value.id) request.finish(undefined)
      return
    }
    if (value.t !== "asset" || typeof value.requestId !== "string") return
    const request = this.pending.get(value.requestId)
    if (!request || request.id !== value.id) return
    this.session = value.session
    const asset =
      validateMediaAsset(value.asset) && value.asset.id === request.id ? value.asset : undefined
    if (asset) this.ids.add(asset.id)
    request.finish(asset)
  }
  dispose() {
    this.disposed = true
    for (const request of [...this.pending.values()]) request.finish(undefined)
    for (const id of this.ids) getPetSkinRuntime().invalidateAsset(`media:${id}`)
    this.ids.clear()
    this.failedIds.clear()
    this.retiredSessions.clear()
    this.wire?.close()
    if (this.wire) this.wire.onmessage = null
  }
}
const CLIENT_KEY = Symbol.for("cognia.pet.media-client")
function client(): MediaAssetClient {
  const root = globalThis as typeof globalThis & { [CLIENT_KEY]?: MediaAssetClient }
  if (!root[CLIENT_KEY]) {
    const value = new MediaAssetClient()
    root[CLIENT_KEY] = value
    if (typeof window !== "undefined")
      window.addEventListener(
        "pagehide",
        () => {
          value.dispose()
          delete root[CLIENT_KEY]
        },
        { once: true }
      )
  }
  return root[CLIENT_KEY]!
}
export function loadMediaSkinAsset(id: string): Promise<MediaPackAsset | undefined> {
  const role = getPetWindowRole()
  return getPetSkinRuntime().loadAsset(`media:${id}`, async () => {
    const asset =
      role === "overlay" || role === "popup"
        ? await client().request(id)
        : await getPetMediaPack(id)
    return validateMediaAsset(asset) ? asset : undefined
  })
}
