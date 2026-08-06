import "fake-indexeddb/auto"

import type { CdpAuditEvent, CdpGrant } from "@/types/browser-developer"
import {
  __enableDbRuntimeForTesting,
  __resetDbForTesting,
  getDb,
  LEGACY_COGNIA_DB_NAME,
} from "./schema"
import {
  appendCdpAuditEvent,
  deleteExpiredCdpGrants,
  getActiveCdpGrant,
  listCdpAuditEvents,
  normalizeCdpOrigin,
  putCdpGrant,
  revokeCdpGrant,
} from "./browser-cdp"

const grant = (overrides: Partial<CdpGrant> = {}): CdpGrant => ({
  id: "grant-1",
  sessionId: "session-1",
  browserSessionId: "browser-1",
  origin: "http://localhost:3000",
  capabilities: ["dom", "console"],
  grantedAt: 10,
  expiresAt: 20,
  ...overrides,
})

describe("browser CDP metadata persistence", () => {
  let disableDbRuntime: (() => void) | undefined

  beforeEach(async () => {
    disableDbRuntime = __enableDbRuntimeForTesting()
    __resetDbForTesting()
    await indexedDB.deleteDatabase(LEGACY_COGNIA_DB_NAME)
  })

  afterEach(async () => {
    await getDb().delete()
    __resetDbForTesting()
    disableDbRuntime?.()
  })

  it("normalizes origins and enforces exact session, browser, capability, and expiry", async () => {
    await putCdpGrant(grant({ origin: "http://localhost:3000/private?token=secret" }))

    await expect(
      getActiveCdpGrant({
        id: "grant-1",
        sessionId: "session-1",
        browserSessionId: "browser-1",
        origin: "http://localhost:3000/another",
        capability: "dom",
        now: 19,
      })
    ).resolves.toEqual(expect.objectContaining({ origin: "http://localhost:3000" }))
    await expect(
      getActiveCdpGrant({
        id: "grant-1",
        sessionId: "other-session",
        browserSessionId: "browser-1",
        origin: "http://localhost:3000",
        capability: "dom",
        now: 19,
      })
    ).resolves.toBeUndefined()
    await expect(
      getActiveCdpGrant({
        id: "grant-1",
        sessionId: "session-1",
        browserSessionId: "browser-1",
        origin: "http://localhost:3000",
        capability: "network",
        now: 19,
      })
    ).resolves.toBeUndefined()
    await expect(
      getActiveCdpGrant({
        id: "grant-1",
        sessionId: "session-1",
        browserSessionId: "browser-1",
        origin: "http://localhost:3000",
        capability: "dom",
        now: 20,
      })
    ).resolves.toBeUndefined()
  })

  it("keeps audit events immutable and strips URL path/query data", async () => {
    const event = {
      id: "audit-1",
      sessionId: "session-1",
      browserSessionId: "browser-1",
      origin: "https://example.com/private?token=secret",
      capability: "network",
      method: "Network.enable",
      outcome: "used",
      createdAt: 12,
    } satisfies CdpAuditEvent
    await appendCdpAuditEvent(event)
    await expect(
      appendCdpAuditEvent({ ...event, method: "Runtime.evaluate" })
    ).rejects.toBeDefined()

    expect(await listCdpAuditEvents("session-1")).toEqual([
      expect.objectContaining({ origin: "https://example.com", method: "Network.enable" }),
    ])
  })

  it("revokes atomically and removes expired authority", async () => {
    await putCdpGrant(grant())
    expect(await revokeCdpGrant("grant-1", 15, "audit-revoke")).toBe(true)
    expect(await revokeCdpGrant("grant-1", 16, "ignored-second-audit")).toBe(true)
    expect(await listCdpAuditEvents("session-1")).toHaveLength(1)
    await expect(
      getActiveCdpGrant({
        id: "grant-1",
        sessionId: "session-1",
        browserSessionId: "browser-1",
        origin: "http://localhost:3000",
        capability: "dom",
        now: 16,
      })
    ).resolves.toBeUndefined()

    await putCdpGrant(grant({ id: "grant-expired", expiresAt: 11 }))
    expect(await deleteExpiredCdpGrants(12)).toBe(1)
  })

  it("rejects non-HTTP origins and invalid lifetimes", async () => {
    expect(() => normalizeCdpOrigin("file:///tmp/index.html")).toThrow(/HTTP/)
    await expect(putCdpGrant(grant({ expiresAt: 10 }))).rejects.toThrow(/expire after/)
  })
})

describe("device-local by construction", () => {
  it.each(["cdpGrants", "cdpAuditEvents"])(
    "keeps %s outside Companion sync and desktop delta reads",
    async (table) => {
      const { SYNC_HANDLER_TABLES } = await import("@/lib/sync/companion-sync")
      const { readDexieDelta } = await import("@/lib/sync/desktop-sync-source")

      expect(SYNC_HANDLER_TABLES).not.toContain(table)
      await expect(readDexieDelta(table as never, 0)).rejects.toThrow(/unknown sync table/)
    }
  )

  it("keeps grant and audit metadata outside the clearable-table surface", async () => {
    const clear = await import("@/lib/data/clear")
    expect(Object.keys(clear)).not.toContain("cdpGrants")
    expect(Object.keys(clear)).not.toContain("cdpAuditEvents")
  })
})
