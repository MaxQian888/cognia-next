import { MediaAssetClient, startMainMediaAssets, type MediaChannel } from "./asset-bridge"
import { getPetSkinRuntime, resetPetSkinRuntimeForTests } from "@/lib/pet/skin-runtime"
import type { PetMediaPackRow } from "@/lib/db/pet-media-packs"
class Wire implements MediaChannel {
  onmessage: MediaChannel["onmessage"] = null
  peer?: Wire
  messages: unknown[] = []
  closed = false
  postMessage(data: unknown) {
    this.messages.push(data)
    const listener = this.peer?.onmessage
    if (listener) queueMicrotask(() => listener({ data }))
  }
  close() {
    this.closed = true
    this.onmessage = null
  }
  deliver(data: unknown) {
    this.onmessage?.({ data })
  }
}
const asset: PetMediaPackRow = {
  id: "mp_test",
  displayName: "Whale",
  manifest: {
    version: 1,
    displayName: "Whale",
    source: "dsh-frames",
    width: 412,
    height: 344,
    clips: { idle: { kind: "frames", frames: ["idle.webp"], frameMs: 42, loop: true } },
    states: { idle: ["idle"] },
    ambient: [],
  },
  entries: [{ path: "idle.webp", blob: new Blob(["frame"]) }],
  totalBytes: 5,
  createdAt: 0,
}
const cleanups: Array<() => void> = []
const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}
beforeEach(resetPetSkinRuntimeForTests)
afterEach(() => {
  for (const stop of cleanups.splice(0)) stop()
})
function setup(read = jest.fn(async () => asset)) {
  const main = new Wire(),
    wire = new Wire()
  main.peer = wire
  wire.peer = main
  let selected: string | undefined = asset.id
  const server = startMainMediaAssets({
    channel: main,
    selectedPack: () => selected,
    readPack: read,
  })
  const client = new MediaAssetClient(wire, 25)
  cleanups.push(() => {
    client.dispose()
    server.dispose()
  })
  return {
    main,
    wire,
    client,
    server,
    read,
    select(id?: string) {
      selected = id
      server.sync()
    },
  }
}
it("serves only the selected account pack, once despite ready/request catch-up", async () => {
  const { client, read } = setup()
  expect(await client.request(asset.id)).toEqual(asset)
  expect(read).toHaveBeenCalledTimes(1)
  expect(await client.request("mp_foreign")).toBeUndefined()
  expect(read).toHaveBeenCalledTimes(1)
})
it("catches up a client that started before main", async () => {
  const wire = new Wire(),
    main = new Wire()
  wire.peer = main
  main.peer = wire
  const client = new MediaAssetClient(wire, 100),
    pending = client.request(asset.id)
  const read = jest.fn(async () => asset)
  const server = startMainMediaAssets({
    channel: main,
    selectedPack: () => asset.id,
    readPack: read,
  })
  cleanups.push(() => {
    client.dispose()
    server.dispose()
  })
  expect(await pending).toEqual(asset)
  expect(read).toHaveBeenCalledTimes(1)
})
it("revokes a pending read on account lock and ignores its late completion", async () => {
  let finish!: (value: PetMediaPackRow) => void
  const { client, select } = setup(
    jest.fn(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
  )
  const pending = client.request(asset.id)
  await flush()
  select(undefined)
  expect(await pending).toBeUndefined()
  finish(asset)
  await flush()
  expect(getPetSkinRuntime().assetDiagnostic(`media:${asset.id}`)).toBeUndefined()
})
it("replaces an epoch even if old main's revoke was missed, fencing stale responses and cached bytes", async () => {
  const { wire, client } = setup()
  await client.request(asset.id)
  const loader = jest.fn(async () => "old bytes")
  await getPetSkinRuntime().loadAsset(`media:${asset.id}`, loader)
  const oldRequest = client.request(asset.id)
  const nonce = (wire.messages.at(-1) as { requestId: string }).requestId
  wire.deliver({ v: 1, t: "ready", id: asset.id, session: "replacement" })
  wire.deliver({ v: 1, t: "asset", id: asset.id, session: "retired", requestId: nonce, asset })
  expect(await oldRequest).toBeUndefined()
  await getPetSkinRuntime().loadAsset(`media:${asset.id}`, loader)
  expect(loader).toHaveBeenCalledTimes(2)
  expect(getPetSkinRuntime().retryGeneration(`media:${asset.id}`)).toBe(1)
})
it("rejects malformed payloads and settles outstanding requests on disposal", async () => {
  const wire = new Wire(),
    client = new MediaAssetClient(wire, 20)
  cleanups.push(() => client.dispose())
  const pending = client.request(asset.id),
    requestId = (wire.messages.at(-1) as { requestId: string }).requestId
  wire.deliver({
    v: 1,
    t: "asset",
    id: asset.id,
    session: "s",
    requestId,
    asset: { ...asset, entries: [{ path: "https://evil/frame", blob: new Blob(["frame"]) }] },
  })
  expect(await pending).toBeUndefined()
  const next = client.request(asset.id)
  client.dispose()
  expect(await next).toBeUndefined()
  expect(wire.closed).toBe(true)
})

it("does not rewind to a retired main when ready messages arrive late", async () => {
  const wire = new Wire(),
    client = new MediaAssetClient(wire, 50)
  cleanups.push(() => client.dispose())
  wire.deliver({ v: 1, t: "ready", session: "old" })
  wire.deliver({ v: 1, t: "ready", session: "new" })
  wire.deliver({ v: 1, t: "ready", session: "old" })
  const pending = client.request(asset.id)
  const requestId = (wire.messages.at(-1) as { requestId: string }).requestId
  wire.deliver({ v: 1, t: "asset", session: "new", id: asset.id, requestId, asset })
  expect(await pending).toEqual(asset)
})

it("immediately revokes cached bytes and pending requests without waiting for timeout", async () => {
  const wire = new Wire(),
    client = new MediaAssetClient(wire, 60_000)
  cleanups.push(() => client.dispose())
  wire.deliver({ v: 1, t: "ready", session: "old" })
  const load = jest.fn(async () => asset)
  await getPetSkinRuntime().loadAsset(`media:${asset.id}`, load)
  let settled = false
  const pending = client.request(asset.id).then((value) => {
    settled = true
    return value
  })
  const requestId = (wire.messages.at(-1) as { requestId: string }).requestId
  wire.deliver({ v: 1, t: "revoke", session: "old", id: asset.id })
  await flush()
  expect(settled).toBe(true)
  expect(await pending).toBeUndefined()
  wire.deliver({ v: 1, t: "asset", session: "old", id: asset.id, requestId, asset })
  await getPetSkinRuntime().loadAsset(`media:${asset.id}`, load)
  expect(load).toHaveBeenCalledTimes(2)
})

it("retries a failed renderer when main starts after the request timed out", async () => {
  const wire = new Wire(),
    client = new MediaAssetClient(wire, 1)
  cleanups.push(() => client.dispose())
  await getPetSkinRuntime().loadAsset(`media:${asset.id}`, () => client.request(asset.id))
  expect(getPetSkinRuntime().retryGeneration(`media:${asset.id}`)).toBe(0)
  wire.deliver({ v: 1, t: "ready", session: "new", id: asset.id })
  expect(getPetSkinRuntime().retryGeneration(`media:${asset.id}`)).toBe(1)
})
