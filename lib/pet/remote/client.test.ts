import type { Transport } from "@/lib/tauri/transport-types"
import { createPetRemoteClient, newPetIntentKey, PetRemoteSnapshotError } from "./client"
import {
  CompanionTransport,
  __setAuthorizationHeadersProviderForTests,
} from "@/lib/tauri/transport-companion"

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const UUID_V8 = /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const INTENT_KEY = "ad60e4a7-4fbf-4dd0-a4bd-24a48a78e129"

function makeTransport(answer: unknown = { ok: true }) {
  const call = jest.fn(async (..._args: Parameters<Transport["call"]>) => answer)
  const transport = {
    call: call as unknown as Transport["call"],
    subscribe: jest.fn(() => () => {}) as unknown as Transport["subscribe"],
  } as Transport
  return { transport, call }
}

describe("pet remote client", () => {
  it("sends bare UUID headers through the companion transport for every write", async () => {
    const transport = new CompanionTransport({
      configProvider: () => ({
        baseUrl: "https://pet-host.test",
        deviceId: "pet-test-device",
        serviceToken: "test-token",
        serverVersion: "test",
      }),
    })
    __setAuthorizationHeadersProviderForTests(async () => ({ Authorization: "Bearer test-token" }))
    const fetchSpy = jest.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ result: { ok: true } }),
    } as Response)
    try {
      const client = createPetRemoteClient(transport)
      await client.act("fed")
      await client.rename("Bao")
      await client.purchase("berry", 2)
      await client.applyDecor("beanie")
      await client.hatch()
      await client.sendChat("hi", "en")
      await client.clearChat()
      expect(fetchSpy).toHaveBeenCalledTimes(7)
      const keys = fetchSpy.mock.calls.map(([, init]) => {
        const key = new Headers(init?.headers).get("Idempotency-Key")
        expect(key).toMatch(UUID_V4)
        const body = JSON.parse(init?.body as string)
        if (body.idempotencyKey !== undefined) expect(body.idempotencyKey).toBe(key)
        return key
      })
      expect(new Set(keys).size).toBe(7)
    } finally {
      transport.destroy()
      fetchSpy.mockRestore()
      __setAuthorizationHeadersProviderForTests(null)
    }
  })

  it("sends one key per intent in the body AND as the transport idempotency key", async () => {
    const { transport, call } = makeTransport()
    const client = createPetRemoteClient(transport, { newKey: () => INTENT_KEY })
    await client.act("fed", { itemId: "berry" })
    expect(call).toHaveBeenCalledWith(
      "pet_act",
      { action: "fed", itemId: "berry", idempotencyKey: INTENT_KEY },
      { idempotencyKey: INTENT_KEY }
    )
  })

  it("reuses a caller-held key, so a retry of the same intent folds on the host", async () => {
    const { transport, call } = makeTransport()
    const newKey = jest.fn(() => "fresh")
    const client = createPetRemoteClient(transport, { newKey })
    await client.purchase("berry", 2, { idempotencyKey: INTENT_KEY })
    await client.sendChat("hi", "en", { idempotencyKey: INTENT_KEY })
    expect(newKey).not.toHaveBeenCalled()
    expect(call).toHaveBeenNthCalledWith(
      1,
      "pet_item_purchase",
      { itemId: "berry", qty: 2, idempotencyKey: INTENT_KEY },
      { idempotencyKey: INTENT_KEY }
    )
    expect(call).toHaveBeenNthCalledWith(
      2,
      "pet_chat_send",
      { text: "hi", locale: "en", idempotencyKey: INTENT_KEY },
      { idempotencyKey: INTENT_KEY }
    )
  })

  it("keeps closed request bodies closed: the key rides the transport only", async () => {
    const { transport, call } = makeTransport()
    const client = createPetRemoteClient(transport, { newKey: () => INTENT_KEY })
    await client.applyDecor("beanie")
    await client.rename("Bao")
    await client.hatch()
    await client.clearChat()
    expect(call.mock.calls).toEqual([
      ["pet_item_apply", { itemId: "beanie" }, { idempotencyKey: INTENT_KEY }],
      ["pet_rename", { name: "Bao" }, { idempotencyKey: INTENT_KEY }],
      ["pet_soul_generate", {}, { idempotencyKey: INTENT_KEY }],
      ["pet_chat_clear", {}, { idempotencyKey: INTENT_KEY }],
    ])
  })

  it.each(["pet:ad60e4a7-4fbf-4dd0-a4bd-24a48a78e129", "intent-7", "x".repeat(128)])(
    "preserves body key %s and uses a stable UUID for retries across client instances",
    async (key) => {
      const { transport, call } = makeTransport()
      const newKey = jest.fn(() => INTENT_KEY)
      const client = createPetRemoteClient(transport, { newKey })
      await client.act("fed", { idempotencyKey: key })
      await createPetRemoteClient(transport, { newKey }).act("fed", { idempotencyKey: key })
      const transportKey = call.mock.calls[0][2]?.idempotencyKey
      expect(transportKey).toMatch(UUID_V8)
      expect(call.mock.calls[1]).toEqual(call.mock.calls[0])
      expect(call.mock.calls[0][1]).toEqual({ action: "fed", idempotencyKey: key })
      await client.purchase("berry", 2, { idempotencyKey: `${key.slice(0, 127)}y` })
      expect(call.mock.calls[2][2]?.idempotencyKey).toMatch(UUID_V8)
      expect(call.mock.calls[2][2]?.idempotencyKey).not.toBe(transportKey)
      await client.sendChat("hi", "en", { idempotencyKey: key })
      expect(call.mock.calls[3][1]).toEqual({ text: "hi", locale: "en", idempotencyKey: key })
      expect(call.mock.calls[3][2]?.idempotencyKey).toBe(transportKey)
      expect(newKey).not.toHaveBeenCalled()
    }
  )

  it("reads the history without a key and only the paging fields given", async () => {
    const { transport, call } = makeTransport({ items: [] })
    const client = createPetRemoteClient(transport)
    await client.listChat()
    await client.listChat({ pageSize: 20, pageToken: "pc:20" })
    expect(call.mock.calls).toEqual([
      ["pet_chat_list", {}],
      ["pet_chat_list", { pageSize: 20, pageToken: "pc:20" }],
    ])
  })

  it("validates the snapshot it is handed", async () => {
    const good = {
      availability: { available: false, reason: "host-starting" },
      summary: null,
      presentation: null,
      hostTime: 1,
    }
    await expect(createPetRemoteClient(makeTransport(good).transport).getSnapshot()).resolves.toBe(
      good
    )
    await expect(
      createPetRemoteClient(makeTransport({ nope: true }).transport).getSnapshot()
    ).rejects.toBeInstanceOf(PetRemoteSnapshotError)
  })

  it("mints distinct UUID v4 intent keys", () => {
    const a = newPetIntentKey()
    const b = newPetIntentKey()
    expect(a).toMatch(UUID_V4)
    expect(b).toMatch(UUID_V4)
    expect(a).not.toBe(b)
  })
})

describe("pet intent key secure randomness", () => {
  const originalCrypto = Object.getOwnPropertyDescriptor(globalThis, "crypto")!

  afterEach(() => {
    Object.defineProperty(globalThis, "crypto", originalCrypto)
  })

  it.each([
    [0x00, "00000000-0000-4000-8000-000000000000"],
    [0xff, "ffffffff-ffff-4fff-bfff-ffffffffffff"],
  ])("formats CSPRNG bytes %i as a UUID v4 without randomUUID", (byte, expected) => {
    const getRandomValues = jest.fn((bytes: Uint8Array) => bytes.fill(byte))
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: { getRandomValues },
    })
    expect(newPetIntentKey()).toBe(expected)
    expect(getRandomValues).toHaveBeenCalledWith(expect.any(Uint8Array))
  })

  it("mints distinct UUIDs with the older WebView CSPRNG fallback", () => {
    const cryptoApi = globalThis.crypto
    Object.defineProperty(globalThis, "crypto", {
      configurable: true,
      value: { getRandomValues: cryptoApi.getRandomValues.bind(cryptoApi) },
    })
    const a = newPetIntentKey()
    const b = newPetIntentKey()
    expect(a).toMatch(UUID_V4)
    expect(b).toMatch(UUID_V4)
    expect(a).not.toBe(b)
  })

  it.each([undefined, {}])("refuses to mint a key without a secure random source (%s)", (value) => {
    Object.defineProperty(globalThis, "crypto", { configurable: true, value })
    expect(() => newPetIntentKey()).toThrow("no secure random source for a pet intent key")
  })
})
