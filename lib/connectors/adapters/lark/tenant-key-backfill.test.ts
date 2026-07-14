import { applyTenantKeyBackfill } from "./tenant-key-backfill"
import type { LarkEventEnvelope } from "./parse"
import type { AdapterInstanceRow } from "@/lib/db/connector-types"

const WHOAMI = { botName: "Bot", appId: "cli_x", openId: "ou_bot" }

function envelope(part: {
  headerTenant?: string
  senderTenant?: string
  readerTenant?: string
}): LarkEventEnvelope {
  return {
    schema: "2.0",
    header: {
      event_id: "e1",
      event_type: "im.message.receive_v1",
      ...(part.headerTenant ? { tenant_key: part.headerTenant } : {}),
    },
    event: {
      ...(part.senderTenant
        ? { sender: { sender_id: { open_id: "ou_u" }, tenant_key: part.senderTenant } }
        : {}),
      ...(part.readerTenant ? { reader: { tenant_key: part.readerTenant } } : {}),
    },
  } as LarkEventEnvelope
}

function makeDeps(row: Partial<AdapterInstanceRow> | undefined) {
  const getAdapterInstance = jest.fn(async () => row as AdapterInstanceRow | undefined)
  const updateAdapterInstance = jest.fn(async () => 1)
  return { getAdapterInstance, updateAdapterInstance }
}

describe("applyTenantKeyBackfill", () => {
  it("writes tenantKey (merged onto whoami) and settles when absent", async () => {
    const deps = makeDeps({ lastWhoamiResult: { ...WHOAMI } })
    const done = await applyTenantKeyBackfill("cai_1", envelope({ headerTenant: "tk_123" }), deps)
    expect(done).toBe(true)
    expect(deps.updateAdapterInstance).toHaveBeenCalledWith("cai_1", {
      lastWhoamiResult: { ...WHOAMI, tenantKey: "tk_123" },
    })
  })

  it("settles without writing when tenantKey is already recorded", async () => {
    const deps = makeDeps({ lastWhoamiResult: { ...WHOAMI, tenantKey: "tk_old" } })
    const done = await applyTenantKeyBackfill("cai_1", envelope({ headerTenant: "tk_new" }), deps)
    expect(done).toBe(true)
    expect(deps.updateAdapterInstance).not.toHaveBeenCalled()
  })

  it("does not settle (retry later) when the whoami row is not persisted yet", async () => {
    const deps = makeDeps({ lastWhoamiResult: undefined })
    const done = await applyTenantKeyBackfill("cai_1", envelope({ headerTenant: "tk_123" }), deps)
    expect(done).toBe(false)
    expect(deps.updateAdapterInstance).not.toHaveBeenCalled()
  })

  it("short-circuits (no DB read) when the envelope carries no tenant_key", async () => {
    const deps = makeDeps({ lastWhoamiResult: { ...WHOAMI } })
    const done = await applyTenantKeyBackfill("cai_1", envelope({}), deps)
    expect(done).toBe(false)
    expect(deps.getAdapterInstance).not.toHaveBeenCalled()
    expect(deps.updateAdapterInstance).not.toHaveBeenCalled()
  })

  it("falls back to the sender's tenant_key when the header lacks it", async () => {
    const deps = makeDeps({ lastWhoamiResult: { ...WHOAMI } })
    const done = await applyTenantKeyBackfill(
      "cai_1",
      envelope({ senderTenant: "tk_sender" }),
      deps
    )
    expect(done).toBe(true)
    expect(deps.updateAdapterInstance).toHaveBeenCalledWith("cai_1", {
      lastWhoamiResult: { ...WHOAMI, tenantKey: "tk_sender" },
    })
  })
})
