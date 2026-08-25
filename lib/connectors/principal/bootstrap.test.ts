/** @jest-environment jsdom */

import "fake-indexeddb/auto"
import { __resetDbForTesting, getDb } from "@/lib/db/schema"
import { getFeishuPrincipal, getFeishuTenant, upsertFeishuTenant } from "@/lib/db/feishu-principals"
import type { PlatformIdentityRow } from "@/lib/db/connector-types"
import type { AuditEntry } from "@/types/connectors/audit"
import { findUserIdByExternalIdentity, linkExternalIdentity, upsertUser } from "@/lib/db/identity"
import { isUserId } from "@/types/identity"
import { bootstrapFeishuRegistry } from "./bootstrap"

const NOW = 1_800_000_000_000

const whoami = {
  botName: "bot",
  appId: "cli_1",
  openId: "ou_bot",
  tenantKey: "tk_a",
}

const adapterRow = {
  settings: { larkPrincipalRegistry: true } as Record<string, unknown>,
  lastWhoamiResult: whoami,
}

function identity(overrides: Partial<PlatformIdentityRow>): PlatformIdentityRow {
  return {
    id: "pi_1",
    platform: "lark",
    adapterId: "lark-1",
    remoteUserId: "ou_1",
    lastSeenAt: NOW,
    ...overrides,
  } as PlatformIdentityRow
}

function deps(identities: PlatformIdentityRow[]) {
  const rows: AuditEntry[] = []
  return {
    rows,
    overrides: {
      audit: async (entry: Omit<AuditEntry, "id"> & { id?: string }) => {
        const row = { id: entry.id ?? `a${rows.length}`, ...entry } as AuditEntry
        rows.push(row)
        return row
      },
      now: () => NOW,
      activeAccountId: () => "acct_a",
      listIdentities: async () => identities,
    },
  }
}

describe("bootstrapFeishuRegistry", () => {
  beforeEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })

  afterEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
  })

  it("does nothing when the registry flag is off", async () => {
    const { overrides } = deps([identity({})])
    const result = await bootstrapFeishuRegistry(
      {
        adapterId: "lark-1",
        adapterRow: { settings: { larkPrincipalRegistry: false }, lastWhoamiResult: whoami },
      },
      overrides
    )
    expect(result).toEqual({ status: "skipped", reason: "flag_off" })
    expect(await getFeishuTenant("tk_a", "cli_1")).toBeUndefined()
  })

  it("never guesses a missing tenantKey", async () => {
    const { overrides } = deps([identity({})])
    const result = await bootstrapFeishuRegistry(
      {
        adapterId: "lark-1",
        adapterRow: {
          settings: { larkPrincipalRegistry: true },
          lastWhoamiResult: { botName: "bot", appId: "cli_1", openId: "ou_bot" },
        },
      },
      overrides
    )
    expect(result).toEqual({ status: "skipped", reason: "identity_unknown" })
    expect(await getDb().feishuTenants.count()).toBe(0)
  })

  it("seeds the tenant and every already-known human sender", async () => {
    const { rows, overrides } = deps([
      identity({ id: "pi_1", remoteUserId: "ou_1" }),
      identity({ id: "pi_2", remoteUserId: "ou_2", kind: "human" }),
    ])

    const result = await bootstrapFeishuRegistry({ adapterId: "lark-1", adapterRow }, overrides)

    expect(result).toEqual({
      status: "seeded",
      tenantId: expect.any(String),
      seeded: 2,
      skipped: 0,
      peopleCreated: 2,
    })
    const tenant = await getFeishuTenant("tk_a", "cli_1")
    expect(tenant?.cogniaAccountId).toBe("acct_a")

    const first = await getFeishuPrincipal("tk_a", "cli_1", "ou_1")
    expect(first?.status).toBe("active")
    expect(first?.platformIdentityId).toBe("pi_1")
    expect(first?.cogniaAccountId).toBe("acct_a")

    // ADR-0149 Batch 5 — two senders are two people. Seeding used to write the
    // operator's own LocalProfile id into both rows, which said every message
    // from this workspace was sent by the operator.
    const second = await getFeishuPrincipal("tk_a", "cli_1", "ou_2")
    expect(isUserId(first?.cogniaUserId ?? "")).toBe(true)
    expect(isUserId(second?.cogniaUserId ?? "")).toBe(true)
    expect(first?.cogniaUserId).not.toBe("acct_a")
    expect(first?.cogniaUserId).not.toBe(second?.cogniaUserId)

    // Each is reachable from their platform id, so the next message finds the
    // same person instead of minting a second one.
    expect(await findUserIdByExternalIdentity("lark", "ou_1", "tk_a/cli_1")).toBe(
      first?.cogniaUserId
    )

    const summary = rows.find((r) => r.kind === "principal.bound")
    expect(summary?.reason).toBe("bootstrap")
    expect(summary?.fields).toMatchObject({ seeded: 2, skipped: 0, peopleCreated: 2 })
  })

  it("reuses a person who already reached the identity plane another way", async () => {
    // The same human, already known from web SSO. Seeding must find them
    // rather than mint a duplicate — ADR-0149 §3's whole point.
    await upsertUser({ id: "usr_ada", displayName: "Ada", createdAt: 1, updatedAt: 1 })
    await linkExternalIdentity({
      userId: "usr_ada",
      provider: "lark",
      subject: "ou_1",
      tenant: "tk_a/cli_1",
      now: 1,
    })

    const { overrides } = deps([identity({ id: "pi_1", remoteUserId: "ou_1" })])
    const result = await bootstrapFeishuRegistry({ adapterId: "lark-1", adapterRow }, overrides)

    expect(result).toMatchObject({ seeded: 1, peopleCreated: 0 })
    expect((await getFeishuPrincipal("tk_a", "cli_1", "ou_1"))?.cogniaUserId).toBe("usr_ada")
    expect(await getDb().users.count()).toBe(1)
  })

  it("skips the bot's own identity", async () => {
    const { overrides } = deps([
      identity({ id: "pi_bot", remoteUserId: "ou_bot" }),
      identity({ id: "pi_1", remoteUserId: "ou_1" }),
    ])
    const result = await bootstrapFeishuRegistry({ adapterId: "lark-1", adapterRow }, overrides)
    expect(result).toEqual({
      status: "seeded",
      tenantId: expect.any(String),
      seeded: 1,
      skipped: 1,
      peopleCreated: 1,
    })
    expect(await getFeishuPrincipal("tk_a", "cli_1", "ou_bot")).toBeUndefined()
  })

  it("counts a duplicate identity row as skipped instead of throwing", async () => {
    const { overrides } = deps([
      identity({ id: "pi_1", remoteUserId: "ou_1" }),
      identity({ id: "pi_dup", remoteUserId: "ou_1" }),
    ])
    const result = await bootstrapFeishuRegistry({ adapterId: "lark-1", adapterRow }, overrides)
    expect(result).toEqual({
      status: "seeded",
      tenantId: expect.any(String),
      seeded: 1,
      skipped: 1,
      peopleCreated: 1,
    })
  })

  it("is once-per-tenant — an existing tenant row is never re-seeded", async () => {
    await upsertFeishuTenant({ tenantKey: "tk_a", appId: "cli_1", cogniaAccountId: "acct_a" })
    const { rows, overrides } = deps([identity({ remoteUserId: "ou_1" })])

    const result = await bootstrapFeishuRegistry({ adapterId: "lark-1", adapterRow }, overrides)

    expect(result).toEqual({ status: "skipped", reason: "already_registered" })
    expect(await getFeishuPrincipal("tk_a", "cli_1", "ou_1")).toBeUndefined()
    expect(rows).toHaveLength(0)
  })

  it("reads only lark identities belonging to this adapter", async () => {
    const db = getDb()
    await db.platformIdentities.bulkAdd([
      identity({ id: "pi_mine", remoteUserId: "ou_1" }),
      identity({ id: "pi_other_adapter", remoteUserId: "ou_2", adapterId: "lark-2" }),
      identity({ id: "pi_bot_kind", remoteUserId: "ou_3", kind: "bot" }),
      { ...identity({ id: "pi_tg", remoteUserId: "ou_4" }), platform: "telegram" },
    ] as PlatformIdentityRow[])

    const rows: AuditEntry[] = []
    const result = await bootstrapFeishuRegistry(
      { adapterId: "lark-1", adapterRow },
      {
        audit: async (entry) => {
          const row = { id: "a", ...entry } as AuditEntry
          rows.push(row)
          return row
        },
        now: () => NOW,
        activeAccountId: () => "acct_a",
      }
    )

    expect(result).toEqual({
      status: "seeded",
      tenantId: expect.any(String),
      seeded: 1,
      skipped: 0,
      peopleCreated: 1,
    })
    expect(await getFeishuPrincipal("tk_a", "cli_1", "ou_1")).toBeDefined()
    expect(await getFeishuPrincipal("tk_a", "cli_1", "ou_2")).toBeUndefined()
    expect(await getFeishuPrincipal("tk_a", "cli_1", "ou_3")).toBeUndefined()
    expect(await getFeishuPrincipal("tk_a", "cli_1", "ou_4")).toBeUndefined()
  })
})
