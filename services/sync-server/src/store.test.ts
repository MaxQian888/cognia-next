import { runInDurableObject } from "cloudflare:test"
import { describe, expect, it } from "vitest"

import { testEnv } from "../test/helpers"
import { FINISHED_REQUEST_RETENTION_MS, SpaceStore, type RequestRow } from "./store"

function stub() {
  return testEnv.SYNC_SPACE.get(testEnv.SYNC_SPACE.idFromName(`store-${crypto.randomUUID()}`))
}

const request = (id: string, overrides: Partial<RequestRow> = {}): RequestRow => ({
  request_id: id,
  device_id: `dev_${id}`,
  platform: "web",
  sign_pub: "S",
  enc_pub: "E",
  commit_hash: "C",
  names: "[]",
  state: "pending",
  created_at: 1_000,
  expires_at: 5_000,
  approver_device_id: null,
  nonce_a: null,
  nonce_r: null,
  entry_seq: null,
  finished_at: null,
  ...overrides,
})

describe("SpaceStore", () => {
  it("expires open requests, counts them and schedules the next alarm", async () => {
    await runInDurableObject(stub(), async (_instance, state) => {
      const store = new SpaceStore(state.storage.sql)
      store.migrate()
      expect(store.nextAlarmAt()).toBeNull()
      store.insertRequest(request("a"))
      store.insertRequest(request("b", { expires_at: 9_000 }))
      store.insertRequest(request("c", { state: "denied", finished_at: 2_000 }))
      expect(store.countOpen()).toBe(2)
      expect(store.countCreatedSince(999)).toBe(3)
      expect(store.nextAlarmAt()).toBe(5_000)
      expect(store.expireDue(6_000)).toBe(1)
      expect(store.request("a")).toMatchObject({ state: "expired", finished_at: 6_000 })
      expect(store.countOpen()).toBe(1)
      expect(store.nextAlarmAt()).toBe(9_000)
      store.updateRequest("b", { state: "cancelled", finished_at: 7_000 })
      expect(store.nextAlarmAt()).toBe(2_000 + FINISHED_REQUEST_RETENTION_MS)
      store.deleteFinishedBefore(2_000)
      expect(store.request("c")).toBeNull()
      expect(store.request("a")).not.toBeNull()
    })
  })

  it("keeps meta, the cached fold and envelopes", async () => {
    await runInDurableObject(stub(), async (_instance, state) => {
      const store = new SpaceStore(state.storage.sql)
      store.migrate()
      store.setMeta("k", "1")
      store.setMeta("k", "2")
      expect(store.meta("k")).toBe("2")
      expect(store.meta("missing")).toBeNull()
      store.cacheState({ head: { seq: 3, hash: "h" } } as never)
      expect(store.cachedState("h")).toMatchObject({ head: { seq: 3 } })
      expect(store.cachedState("other")).toBeNull()
      const envelope = { epoch: 1, recipient: "recovery", recipientEncPub: "E", enc: "x", ct: "y" }
      store.putEnvelope(envelope)
      store.putEnvelope({ ...envelope, epoch: 2 })
      expect(store.envelope("recovery")?.epoch).toBe(2)
      store.replaceEnvelopes([{ ...envelope, recipient: "dev_A", epoch: 3 }])
      expect(store.envelopeRecipients()).toEqual(["dev_A"])
    })
  })
})
