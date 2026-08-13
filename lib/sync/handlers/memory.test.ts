/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"

import type { Transport } from "@/lib/tauri/transport-types"
import type { Memory } from "@/types/memory/memory"
import { getDb } from "@/lib/db/schema"
import { createMemorySyncRowV1, type EncryptedMemorySyncRowV1 } from "../memory-content-protocol"

import { ensurePairedMemoryDek, syncMemories } from "./memory"

function makeTransport(
  rows: EncryptedMemorySyncRowV1[],
  deleted_ids: string[] = [],
  next_since = 1
): Transport {
  return {
    call: jest.fn(async () => ({ rows, deleted_ids, next_since })) as unknown as Transport["call"],
    subscribe: jest.fn(() => () => {}) as unknown as Transport["subscribe"],
  }
}

describe("syncMemories", () => {
  beforeEach(async () => {
    await getDb().memories.clear()
  })

  it("calls sync_pull with table=memories + the given cursor", async () => {
    const tx = makeTransport([], [], 5)
    const out = await syncMemories(tx, { since: 42 })

    expect(tx.call).toHaveBeenCalledWith("sync_pull", {
      table: "memories",
      since: 42,
      content_protocol_version: 1,
    })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.result.nextSince).toBe(5)
  })

  it("persists memory upserts into Dexie", async () => {
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
      "encrypt",
      "decrypt",
    ])
    const memory = (id: string): Memory => ({
      id,
      scope: "global",
      type: "semantic",
      text: `private ${id}`,
      tags: [],
      importance: 5,
      createdAt: 1,
      updatedAt: 2,
      lastAccessedAt: 2,
      accessCount: 0,
      version: 1,
      status: "active",
      pinned: false,
      provenance: "user",
    })
    const rows = await Promise.all(
      ["m1", "m2"].map((id) =>
        createMemorySyncRowV1(memory(id), {
          profileId: "memory-shared",
          keyId: "dek-1",
          key,
        })
      )
    )
    const out = await syncMemories(makeTransport(rows), { since: 0 }, { loadDek: async () => key })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.result.applied).toBe(2)
    expect(await getDb().memories.get("m1")).toMatchObject({ text: "private m1" })
  })

  it("fails closed without the paired profile DEK", async () => {
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
      "encrypt",
      "decrypt",
    ])
    const row = await createMemorySyncRowV1(
      {
        id: "m1",
        scope: "global",
        type: "semantic",
        text: "private",
        tags: [],
        importance: 5,
        createdAt: 1,
        updatedAt: 2,
        lastAccessedAt: 2,
        accessCount: 0,
        version: 1,
        status: "active",
        pinned: false,
        provenance: "user",
      },
      { profileId: "memory-shared", keyId: "dek-1", key }
    )
    const out = await syncMemories(
      makeTransport([row]),
      { since: 0 },
      { loadDek: async () => null }
    )
    expect(out).toMatchObject({ ok: false, failure: { reason: "schema" } })
    expect(await getDb().memories.count()).toBe(0)
  })
})

describe("ensurePairedMemoryDek", () => {
  it("imports a missing DEK from the authenticated companion RPC", async () => {
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
      "encrypt",
      "decrypt",
    ])
    let imported = false
    const importPaired = jest.fn(async () => {
      imported = true
    })
    const store = {
      load: jest.fn(async () =>
        imported ? { profileId: "memory-shared", keyId: "dek-1", key } : null
      ),
      importPaired,
    }
    const raw = Uint8Array.from({ length: 32 }, (_, index) => index)
    const rawKey = btoa(String.fromCharCode(...raw))
    const transport = {
      call: jest.fn(async () => ({
        protocolVersion: 1,
        profileId: "memory-shared",
        keyId: "dek-1",
        rawKey,
      })) as unknown as Transport["call"],
      subscribe: jest.fn(() => () => {}) as unknown as Transport["subscribe"],
    }

    await expect(ensurePairedMemoryDek(transport, "memory-shared", "dek-1", store)).resolves.toBe(
      key
    )
    expect(transport.call).toHaveBeenCalledWith("retrieval_profile_dek_export", {
      profileId: "memory-shared",
      contentProtocolVersion: 1,
    })
    expect(importPaired).toHaveBeenCalledWith("memory-shared", "dek-1", expect.any(Uint8Array), {
      authenticated: true,
      protocolVersion: 1,
    })
  })

  it("rejects a mismatched pairing response", async () => {
    const store = { load: jest.fn(async () => null), importPaired: jest.fn() }
    const transport = {
      call: jest.fn(async () => ({
        protocolVersion: 1,
        profileId: "other",
        keyId: "dek-1",
        rawKey: btoa("x".repeat(32)),
      })) as unknown as Transport["call"],
      subscribe: jest.fn(() => () => {}) as unknown as Transport["subscribe"],
    }

    await expect(
      ensurePairedMemoryDek(transport, "memory-shared", "dek-1", store)
    ).rejects.toMatchObject({ code: "upgrade_required" })
    expect(store.importPaired).not.toHaveBeenCalled()
  })
})
