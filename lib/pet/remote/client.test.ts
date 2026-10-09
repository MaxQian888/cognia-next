import type { Transport } from "@/lib/tauri/transport-types"
import { createPetRemoteClient, newPetIntentKey, PetRemoteSnapshotError } from "./client"

function makeTransport(answer: unknown = { ok: true }) {
  const call = jest.fn(async () => answer)
  const transport = {
    call: call as unknown as Transport["call"],
    subscribe: jest.fn(() => () => {}) as unknown as Transport["subscribe"],
  } as Transport
  return { transport, call }
}

describe("pet remote client", () => {
  it("sends one key per intent in the body AND as the transport idempotency key", async () => {
    const { transport, call } = makeTransport()
    const client = createPetRemoteClient(transport, { newKey: () => "pet:k1" })
    await client.act("fed", { itemId: "berry" })
    expect(call).toHaveBeenCalledWith(
      "pet_act",
      { action: "fed", itemId: "berry", idempotencyKey: "pet:k1" },
      { idempotencyKey: "pet:k1" }
    )
  })

  it("reuses a caller-held key, so a retry of the same intent folds on the host", async () => {
    const { transport, call } = makeTransport()
    const newKey = jest.fn(() => "fresh")
    const client = createPetRemoteClient(transport, { newKey })
    await client.purchase("berry", 2, { idempotencyKey: "intent-7" })
    await client.sendChat("hi", "en", { idempotencyKey: "intent-8" })
    expect(newKey).not.toHaveBeenCalled()
    expect(call).toHaveBeenNthCalledWith(
      1,
      "pet_item_purchase",
      { itemId: "berry", qty: 2, idempotencyKey: "intent-7" },
      { idempotencyKey: "intent-7" }
    )
    expect(call).toHaveBeenNthCalledWith(
      2,
      "pet_chat_send",
      { text: "hi", locale: "en", idempotencyKey: "intent-8" },
      { idempotencyKey: "intent-8" }
    )
  })

  it("keeps closed request bodies closed: the key rides the transport only", async () => {
    const { transport, call } = makeTransport()
    const client = createPetRemoteClient(transport, { newKey: () => "k" })
    await client.applyDecor("beanie")
    await client.rename("Bao")
    await client.hatch()
    await client.clearChat()
    expect(call.mock.calls).toEqual([
      ["pet_item_apply", { itemId: "beanie" }, { idempotencyKey: "k" }],
      ["pet_rename", { name: "Bao" }, { idempotencyKey: "k" }],
      ["pet_soul_generate", {}, { idempotencyKey: "k" }],
      ["pet_chat_clear", {}, { idempotencyKey: "k" }],
    ])
  })

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

  it("mints distinct, prefixed intent keys", () => {
    const a = newPetIntentKey()
    const b = newPetIntentKey()
    expect(a).toMatch(/^pet:/)
    expect(a).not.toBe(b)
  })
})
