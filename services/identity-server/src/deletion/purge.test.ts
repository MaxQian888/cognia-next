import { describe, expect, it, vi } from "vitest"

import { call, signInAndGetTokens, SYNC_AUDIENCE, testEnv } from "../../test/helpers"
import { runScheduled } from "../index"
import { purgeDueDeletions, purgeHooksFor } from "./purge"
import { getDeletion, requestDeletion } from "./store"

async function rowCount(table: string, userId: string): Promise<number> {
  const column = table === "user" ? "id" : "userId"
  const row = await testEnv.DB.prepare(`SELECT COUNT(*) AS n FROM "${table}" WHERE "${column}" = ?`)
    .bind(userId)
    .first<{ n: number }>()
  return row!.n
}

describe("purgeDueDeletions", () => {
  it("has no purge hooks where no sync Worker is bound", () => {
    expect(purgeHooksFor({})).toEqual([])
  })

  it("deletes the sync space through SYNC_ADMIN when it is bound", async () => {
    const purgeSpace = vi.fn(async (userId: string) => ({ spaceId: `space-of-${userId}` }))
    const hooks = purgeHooksFor({ SYNC_ADMIN: { purgeSpace } })
    expect(hooks).toHaveLength(1)
    await hooks[0]!("usr_abc")
    expect(purgeSpace).toHaveBeenCalledWith("usr_abc")
    const failing = purgeHooksFor({
      SYNC_ADMIN: { purgeSpace: async () => Promise.reject(new Error("down")) },
    })
    await expect(failing[0]!("usr_abc")).rejects.toThrow("down")
  })

  it("runs hooks, then removes tokens, consents, sessions, accounts and the user", async () => {
    const { userId, tokens } = await signInAndGetTokens()
    const now = new Date()
    await requestDeletion(testEnv.DB, userId, new Date(now.getTime() - 8 * 24 * 60 * 60 * 1000), 7)
    expect(await rowCount("oauthRefreshToken", userId)).toBeGreaterThan(0)

    const order: string[] = []
    const report = await purgeDueDeletions({
      db: testEnv.DB,
      deleteUser: async (id) => {
        order.push(`deleteUser:${id}`)
        await testEnv.DB.prepare('DELETE FROM "user" WHERE "id" = ?').bind(id).run()
      },
      hooks: [async (id) => void order.push(`hook:${id}`)],
      now: () => now,
    })
    expect(report).toEqual({ purged: [userId], failed: [] })
    expect(order).toEqual([`hook:${userId}`, `deleteUser:${userId}`])
    for (const table of [
      "oauthAccessToken",
      "oauthRefreshToken",
      "oauthConsent",
      "session",
      "account",
      "user",
    ]) {
      expect(await rowCount(table, userId), table).toBe(0)
    }
    expect(await getDeletion(testEnv.DB, userId)).toMatchObject({ status: "purged" })

    // The refresh token is dead.
    const refresh = await call("/api/auth/oauth2/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: "cognia-app",
        refresh_token: tokens.refresh_token!,
        resource: SYNC_AUDIENCE,
      }),
    })
    expect(refresh.ok).toBe(false)
  })

  it("leaves a request pending when a step fails, so the next run retries", async () => {
    const { userId } = await signInAndGetTokens()
    await requestDeletion(testEnv.DB, userId, new Date(Date.now() - 8 * 24 * 60 * 60 * 1000), 7)
    const report = await purgeDueDeletions({
      db: testEnv.DB,
      deleteUser: vi.fn(),
      hooks: [async () => Promise.reject(new Error("sync space unreachable"))],
    })
    expect(report.failed).toEqual([{ userId, error: "sync space unreachable" }])
    expect(await getDeletion(testEnv.DB, userId)).toMatchObject({ status: "pending" })
    expect(await rowCount("user", userId)).toBe(1)
  })

  it("does not touch a request still inside its cooling-off period", async () => {
    const { userId } = await signInAndGetTokens()
    await requestDeletion(testEnv.DB, userId, new Date(), 7)
    const report = await purgeDueDeletions({ db: testEnv.DB, deleteUser: vi.fn() })
    expect(report.purged).not.toContain(userId)
  })
})

describe("the scheduled handler", () => {
  it("purges due accounts with Better Auth's own deletion", async () => {
    const { userId } = await signInAndGetTokens()
    await requestDeletion(testEnv.DB, userId, new Date(Date.now() - 8 * 24 * 60 * 60 * 1000), 7)
    const report = await runScheduled(testEnv)
    expect(report.purged).toContain(userId)
    expect(await rowCount("user", userId)).toBe(0)
    expect(await rowCount("session", userId)).toBe(0)
  })
})
