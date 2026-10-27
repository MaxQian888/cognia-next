import type { PetModelRow } from "@/lib/db/pet-models"
import type { Live2dSkinAsset } from "@/lib/pet/skin-assets"
import { getPetSkinRuntime, resetPetSkinRuntimeForTests } from "@/lib/pet/skin-runtime"
import {
  Live2dAssetMirror,
  startMainLive2dAssets,
  type AssetChannel,
  subscribeLive2dMirror,
  requestMirroredLive2dAsset,
  getMirroredLive2dRow,
} from "./asset-bridge"
import { getPetWindowRole } from "@/lib/pet/window-role"
jest.mock("@/lib/pet/window-role", () => ({ getPetWindowRole: jest.fn(() => "web") }))
import { MAX_MODEL_BYTES } from "./constants"

class Wire implements AssetChannel {
  onmessage: AssetChannel["onmessage"] = null
  peer?: Wire
  closed = false
  messages: unknown[] = []
  postMessage(value: unknown) {
    this.messages.push(value)
    const listener = this.peer?.onmessage
    if (listener) queueMicrotask(() => listener({ data: value }))
  }
  deliver(data: unknown) {
    this.onmessage?.({ data })
  }
  close() {
    this.closed = true
    this.onmessage = null
  }
}

const row: PetModelRow = {
  id: "m1",
  name: "Hiyori",
  source: "sample",
  settingsPath: "Hiyori.model3.json",
  motionGroups: ["Idle"],
  expressionIds: [],
  totalBytes: 3,
  createdAt: 0,
}
const asset: Live2dSkinAsset = { row, entries: [{ path: "Hiyori.moc3", blob: new Blob(["moc"]) }] }
const cleanups: Array<() => void> = []
const flush = async () => {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

function pair() {
  const main = new Wire(),
    client = new Wire()
  main.peer = client
  client.peer = main
  return { main, client }
}

function setup(
  options: {
    selected?: string
    watchInitially?: boolean
    read?: () => Promise<Live2dSkinAsset | undefined>
  } = {}
) {
  const { main, client } = pair()
  let selected: string | undefined = options.selected ?? "m1"
  let publish: (value: PetModelRow | undefined) => void = () => {}
  const unwatch = jest.fn()
  const read = jest.fn(options.read ?? (async () => asset))
  const server = startMainLive2dAssets({
    channel: main,
    selectedModel: () => selected,
    readAsset: read,
    watchRow: (_id, next) => {
      publish = next
      if (options.watchInitially !== false) next(row)
      return unwatch
    },
  })
  const mirror = new Live2dAssetMirror(client, 30)
  cleanups.push(() => {
    mirror.dispose()
    server.dispose()
  })
  return {
    main,
    client,
    server,
    mirror,
    read,
    unwatch,
    publish: (value: PetModelRow | undefined) => publish(value),
    select: (id?: string) => {
      selected = id
      server.sync()
    },
  }
}

beforeEach(() => resetPetSkinRuntimeForTests())
afterEach(() => {
  for (const stop of cleanups.splice(0)) stop()
})

it("catches up a late overlay's metadata before it requests model blobs", async () => {
  const { mirror, read } = setup()
  await flush()
  expect(mirror.rows.get("m1")).toEqual(row)
  expect(read).not.toHaveBeenCalled()
})

it("projects only model fields and observes saved customization without retransferring blobs", async () => {
  const { mirror, publish, read, main } = setup()
  const loaded = await mirror.request("m1")
  expect(loaded?.entries[0].blob).toBe(asset.entries[0].blob)
  expect(read).toHaveBeenCalledTimes(1)
  const listener = jest.fn()
  const unsubscribe = mirror.subscribe(listener)
  publish({
    ...row,
    transform: { scale: 0.65, offsetX: 0.15, offsetY: 0 },
    parameterMapping: { mouthOpen: null },
    accountKey: "must-stay-local",
  } as PetModelRow)
  await flush()
  expect(mirror.rows.get("m1")).toMatchObject({
    transform: { scale: 0.65, offsetX: 0.15 },
    parameterMapping: { mouthOpen: null },
  })
  expect(JSON.stringify(main.messages)).not.toContain("must-stay-local")
  expect(listener).toHaveBeenCalledTimes(1)
  expect(read).toHaveBeenCalledTimes(1)
  unsubscribe()
})

it("rejects requests for an unselected model without reading its account data", async () => {
  const { mirror, read } = setup()
  expect(await mirror.request("another-account-model")).toBeUndefined()
  expect(read).not.toHaveBeenCalled()
})

it("retries a request made before the main responder starts, once", async () => {
  const { main, client } = pair()
  const mirror = new Live2dAssetMirror(client, 100)
  const pending = mirror.request("m1")
  const read = jest.fn(async () => asset)
  const server = startMainLive2dAssets({
    channel: main,
    selectedModel: () => "m1",
    readAsset: read,
    watchRow: (_id, next) => {
      next(row)
      return () => {}
    },
  })
  cleanups.push(() => {
    mirror.dispose()
    server.dispose()
  })
  expect(await pending).toEqual(asset)
  expect(read).toHaveBeenCalledTimes(1)
})

it("revokes metadata and blob cache on account lock, fencing a pending and late reply", async () => {
  let finish!: (value: Live2dSkinAsset) => void
  const { mirror, select, unwatch } = setup({
    watchInitially: false,
    read: () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  })
  const pending = mirror.request("m1")
  await flush()
  const loader = jest.fn(async () => asset.entries)
  await getPetSkinRuntime().loadAsset("live2d:m1", loader)
  select(undefined)
  expect(await pending).toBeUndefined()
  finish(asset)
  await flush()
  expect(mirror.rows.size).toBe(0)
  expect(unwatch).toHaveBeenCalledTimes(1)
  await getPetSkinRuntime().loadAsset("live2d:m1", loader)
  expect(loader).toHaveBeenCalledTimes(2)
})

it("ignores a stale observer and in-flight response after selecting a different model", async () => {
  let finish!: (value: Live2dSkinAsset) => void
  const { mirror, select, publish } = setup({
    read: () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  })
  const pending = mirror.request("m1")
  await flush()
  select(undefined)
  publish({ ...row, name: "stale" })
  finish(asset)
  expect(await pending).toBeUndefined()
  await flush()
  expect(mirror.rows.size).toBe(0)
})

it("settles requests on disposal and ignores messages afterward", async () => {
  const { mirror, client } = setup({ read: () => new Promise(() => {}) })
  const pending = mirror.request("m1")
  mirror.dispose()
  expect(await pending).toBeUndefined()
  client.deliver({ v: 1, t: "metadata", modelId: "m1", session: "late", row })
  expect(mirror.rows.size).toBe(0)
  expect(client.closed).toBe(true)
  expect(await mirror.request("m1")).toBeUndefined()
})

it.each([
  { v: 2, t: "request", modelId: "m1", requestId: "r" },
  { v: 1, t: "request", modelId: "m1", requestId: 42 },
  { v: 1, t: "request", modelId: "m1", requestId: "r".repeat(129) },
  null,
])("ignores malformed requests: %p", async (message) => {
  const { main, read } = setup()
  main.deliver(message)
  await flush()
  expect(read).not.toHaveBeenCalled()
})

it.each(["../secret", "/absolute.moc3", "folder\\secret"])(
  "rejects unsafe asset paths: %s",
  async (path) => {
    const { mirror } = setup({
      read: async () => ({ row, entries: [{ path, blob: new Blob(["moc"]) }] }),
    })
    expect(await mirror.request("m1")).toBeUndefined()
  }
)

it("bounds payloads and requires a matching request nonce", async () => {
  const wire = new Wire()
  const mirror = new Live2dAssetMirror(wire, 20)
  cleanups.push(() => mirror.dispose())
  const pending = mirror.request("m1")
  const request = wire.messages.at(-1) as { requestId: string }
  wire.deliver({
    v: 1,
    t: "asset",
    modelId: "m1",
    session: "s",
    requestId: "unknown",
    row,
    entries: asset.entries,
  })
  expect(mirror.rows.size).toBe(0)
  const blob = new Blob([])
  Object.defineProperty(blob, "size", { value: MAX_MODEL_BYTES + 1 })
  wire.deliver({
    v: 1,
    t: "asset",
    modelId: "m1",
    session: "s",
    requestId: request.requestId,
    row,
    entries: [{ path: "large", blob }],
  })
  expect(await pending).toBeUndefined()
  wire.deliver({
    v: 1,
    t: "metadata",
    modelId: "m1",
    session: "s",
    row: { ...row, totalBytes: -1 },
  })
  expect(mirror.rows.get("m1")).toEqual(row)
})

it("does not let a late timed-out response revive a missing model, but retries when metadata becomes ready", async () => {
  const wire = new Wire(),
    mirror = new Live2dAssetMirror(wire, 10)
  cleanups.push(() => mirror.dispose())
  const pending = mirror.request("m1")
  const request = wire.messages.at(-1) as { requestId: string }
  expect(await pending).toBeUndefined()
  wire.deliver({
    ...request,
    v: 1,
    t: "asset",
    modelId: "m1",
    session: "s",
    row,
    entries: asset.entries,
  })
  expect(mirror.rows.size).toBe(0)
  const runtime = getPetSkinRuntime()
  runtime.recordAssetFailure("live2d:m1", "modelMissing")
  wire.deliver({ v: 1, t: "metadata", modelId: "m1", session: "s", row })
  expect(runtime.assetDiagnostic("live2d:m1")).toBeUndefined()
  expect(runtime.retryGeneration("live2d:m1")).toBe(1)
  expect(mirror.rows.get("m1")).toEqual(row)
})

it("retries after a timeout even if metadata arrives before the renderer records a failure", async () => {
  const wire = new Wire(),
    mirror = new Live2dAssetMirror(wire, 10)
  cleanups.push(() => mirror.dispose())
  expect(await mirror.request("m1")).toBeUndefined()
  wire.deliver({ v: 1, t: "metadata", modelId: "m1", session: "s", row })
  expect(getPetSkinRuntime().retryGeneration("live2d:m1")).toBe(1)
})

it("clears a deleted model, then permits recovery on a new metadata update", async () => {
  const { mirror, publish } = setup()
  await mirror.request("m1")
  publish(undefined)
  await flush()
  expect(mirror.rows.size).toBe(0)
  publish(row)
  await flush()
  expect(mirror.rows.get("m1")).toEqual(row)
  expect(getPetSkinRuntime().retryGeneration("live2d:m1")).toBe(1)
})

it("does not resurrect a deleted row when an earlier blob read finishes in the same session", async () => {
  let finish!: (value: Live2dSkinAsset) => void
  const { mirror, publish } = setup({
    read: () =>
      new Promise((resolve) => {
        finish = resolve
      }),
  })
  const pending = mirror.request("m1")
  await flush()
  publish(undefined)
  await flush()
  finish(asset)
  expect(await pending).toBeUndefined()
  expect(mirror.rows.size).toBe(0)
})

it("rejects more than 2000 asset entries", async () => {
  const { mirror } = setup({
    read: async () => ({
      row,
      entries: Array.from({ length: 2001 }, (_, i) => ({ path: `${i}.moc3`, blob: new Blob([]) })),
    }),
  })
  expect(await mirror.request("m1")).toBeUndefined()
})

it("replaces cached blobs and fences old pending replies when the main session changes", async () => {
  const wire = new Wire(),
    mirror = new Live2dAssetMirror(wire, 100)
  cleanups.push(() => mirror.dispose())
  wire.deliver({ v: 1, t: "metadata", modelId: "m1", session: "old", row })
  const loader = jest.fn(async () => ["old-account-blob"])
  await getPetSkinRuntime().loadAsset("live2d:m1", loader)
  const pending = mirror.request("m1")
  const request = wire.messages.at(-1) as { requestId: string }
  wire.deliver({ v: 1, t: "metadata", modelId: "m1", session: "new", row: { ...row, name: "new" } })
  wire.deliver({
    v: 1,
    t: "asset",
    modelId: "m1",
    session: "old",
    requestId: request.requestId,
    row,
    entries: asset.entries,
  })
  expect(await pending).toBeUndefined()
  expect(mirror.rows.get("m1")?.name).toBe("new")
  await getPetSkinRuntime().loadAsset("live2d:m1", loader)
  expect(loader).toHaveBeenCalledTimes(2)
  expect(getPetSkinRuntime().retryGeneration("live2d:m1")).toBe(1)
})

it("clears main's blob cache even when it has no local rendering lease", async () => {
  const wire = new Wire()
  const server = startMainLive2dAssets({
    channel: wire,
    selectedModel: () => "m1",
    readAsset: async () => asset,
    watchRow: (_id, next) => {
      next(row)
      return () => {}
    },
  })
  const loader = jest.fn(async () => asset.entries)
  await getPetSkinRuntime().loadAsset("live2d:m1", loader)
  server.dispose()
  await getPetSkinRuntime().loadAsset("live2d:m1", loader)
  expect(loader).toHaveBeenCalledTimes(2)
})

it("keeps the production mirror alive across multiple consumers and StrictMode resubscription", async () => {
  const original = globalThis.BroadcastChannel
  const wires: Wire[] = []
  class FakeBroadcastChannel extends Wire {
    constructor() {
      super()
      wires.push(this)
    }
  }
  globalThis.BroadcastChannel = FakeBroadcastChannel as unknown as typeof BroadcastChannel
  jest.mocked(getPetWindowRole).mockReturnValue("overlay")
  let offA = () => {},
    offB = () => {},
    offC = () => {}
  try {
    const listener = jest.fn()
    offA = subscribeLive2dMirror(listener)
    offB = subscribeLive2dMirror(listener)
    const wire = wires[0]
    wire.deliver({ v: 1, t: "metadata", modelId: "m1", session: "s", row })
    expect(getMirroredLive2dRow("m1")).toEqual(row)
    offA()
    offA = () => {}
    offB()
    offB = () => {}
    offC = subscribeLive2dMirror(listener)
    await flush()
    expect(wires).toHaveLength(1)
    expect(wire.closed).toBe(false)
    const pending = requestMirroredLive2dAsset("m1")
    offC()
    offC = () => {}
    expect(await pending).toBeUndefined()
    expect(wire.closed).toBe(true)
    expect(getMirroredLive2dRow("m1")).toBeUndefined()
  } finally {
    offA()
    offB()
    offC()
    await flush()
    globalThis.BroadcastChannel = original
    jest.mocked(getPetWindowRole).mockReturnValue("web")
  }
})
