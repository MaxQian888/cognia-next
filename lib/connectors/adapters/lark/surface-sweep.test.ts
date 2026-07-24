/** @jest-environment jsdom */

import "fake-indexeddb/auto"
import { getDb, __resetDbForTesting } from "@/lib/db/schema"
import {
  ensureChatSurface,
  getChatSurface,
  markChatSurfaceSynced,
} from "@/lib/db/lark-chat-surfaces"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"
import { resyncLarkChatSurfaces, sweepLarkChatSurfaces } from "./surface-sweep"

const ADAPTER_ID = "lark-sweep-1"

function adapterRow(settings: Record<string, unknown>) {
  return { id: ADAPTER_ID, platform: "lark", settings } as unknown as AdapterInstanceRow
}

const ctx = { adapterId: ADAPTER_ID, resolveCreds: async () => ({ appId: "cli", appSecret: "s" }) }

async function seedPending() {
  await ensureChatSurface({
    adapterId: ADAPTER_ID,
    chatId: "oc_a",
    surfaceType: "chat_tab",
    urlVersion: 1,
  })
  await ensureChatSurface({
    adapterId: ADAPTER_ID,
    chatId: "oc_b",
    surfaceType: "group_menu",
    urlVersion: 1,
  })
}

describe("sweepLarkChatSurfaces", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })
  afterEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })

  it("returns immediately without scanning when both surface flags are off", async () => {
    const listDue = jest.fn(async () => [])
    const counts = await sweepLarkChatSurfaces(ctx, {
      getAdapter: jest.fn(async () => adapterRow({})),
      listDue,
    } as never)
    expect(counts).toEqual({ synced: 0, errors: 0, skipped: 0 })
    expect(listDue).not.toHaveBeenCalled()
  })

  it("routes due rows to the reconciler matching their surfaceType", async () => {
    await seedPending()
    const reconcileTab = jest.fn(async () => "synced" as const)
    const reconcileMenu = jest.fn(async () => "error" as const)
    const counts = await sweepLarkChatSurfaces(ctx, {
      getAdapter: jest.fn(async () => adapterRow({ larkChatTab: true, larkGroupMenu: true })),
      reconcileTab,
      reconcileMenu,
    } as never)
    expect(reconcileTab).toHaveBeenCalledWith(ctx, "oc_a", expect.anything())
    expect(reconcileMenu).toHaveBeenCalledWith(ctx, "oc_b", expect.anything())
    expect(counts).toEqual({ synced: 1, errors: 1, skipped: 0 })
  })

  it("skips surface types whose flag is off while running the enabled one", async () => {
    await seedPending()
    const reconcileTab = jest.fn(async () => "synced" as const)
    const reconcileMenu = jest.fn(async () => "synced" as const)
    const counts = await sweepLarkChatSurfaces(ctx, {
      getAdapter: jest.fn(async () => adapterRow({ larkChatTab: true })),
      reconcileTab,
      reconcileMenu,
    } as never)
    expect(reconcileTab).toHaveBeenCalledTimes(1)
    expect(reconcileMenu).not.toHaveBeenCalled()
    expect(counts).toEqual({ synced: 1, errors: 0, skipped: 1 })
  })

  it("resync re-arms synced rows back to pending and sweeps them", async () => {
    await seedPending()
    await markChatSurfaceSynced(ADAPTER_ID, "oc_a", "chat_tab")
    const reconcileTab = jest.fn(async () => "synced" as const)
    const reconcileMenu = jest.fn(async () => "synced" as const)
    await resyncLarkChatSurfaces(ctx, {
      getAdapter: jest.fn(async () => adapterRow({ larkChatTab: true, larkGroupMenu: true })),
      reconcileTab,
      reconcileMenu,
    } as never)
    // The freshly-synced row was re-armed and reconciled again.
    expect(reconcileTab).toHaveBeenCalledWith(ctx, "oc_a", expect.anything())
    const rearmed = await getChatSurface(ADAPTER_ID, "oc_a", "chat_tab")
    expect(rearmed?.status).toBe("pending")
  })
})
