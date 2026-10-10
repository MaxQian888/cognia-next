/**
 * The journal/SQLite rungs of `startDurability`.
 *
 * Its own file on purpose: the capture middleware must install before Dexie
 * opens, and `lib/db/schema.ts` caches ONE `CogniaDB` singleton per module
 * registry. Sharing a file with the snapshot-rung suites would hand this test
 * an already-open database — which the store now refuses outright.
 *
 * @jest-environment node
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

import { startDurability } from "./durability"
import { durabilityRoot } from "./persistence/backend"
import { __resetCliDbForTesting } from "../db/bootstrap"

jest.setTimeout(30_000)

async function dropDatabase(): Promise<void> {
  // fake-indexeddb keeps a database alive for the process; delete it so the
  // next boot can only see what durability restores.
  const { getDb, __resetDbForTesting } = await import("@/lib/db/schema")
  await getDb().delete()
  __resetDbForTesting()
  __resetCliDbForTesting()
}

function session(id: string) {
  return { id, title: id, createdAt: Date.now(), updatedAt: Date.now() } as never
}

describe("startDurability's default rung (ADR-0224)", () => {
  it("boots a fresh account on sqlite, pins it, and persists the first commit", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-sqlite-default-"))
    __resetCliDbForTesting()
    try {
      const first = await startDurability({ home, accountId: "acct_fresh", env: {} })
      expect(first.backend).toBe("sqlite-v5")
      const { getDb } = await import("@/lib/db/schema")
      // Before seeding an empty store, this first commit referenced a database
      // with no schema row and failed its foreign key.
      await getDb().sessions.put(session("fresh-session"))
      await first.dispose()

      const manifest = JSON.parse(
        fs.readFileSync(
          path.join(durabilityRoot(home, "acct_fresh"), "backend-manifest.json"),
          "utf8"
        )
      ) as { activeBackend: string }
      expect(manifest.activeBackend).toBe("sqlite-v5")

      await dropDatabase()
      const second = await startDurability({
        home,
        accountId: "acct_fresh",
        env: { COGNIA_DURABILITY_BACKEND: "journal-v4" },
      })
      // The pinned manifest wins over a later gate.
      expect(second.backend).toBe("sqlite-v5")
      expect(await (await import("@/lib/db/schema")).getDb().sessions.get("fresh-session")).toEqual(
        expect.objectContaining({ id: "fresh-session" })
      )
      await second.dispose()
    } finally {
      await dropDatabase().catch(() => {})
      fs.rmSync(home, { recursive: true, force: true })
    }
  })

  it("imports an account's table store once and leaves it untouched", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-sqlite-import-"))
    const tableManifest = path.join(home, "db-acct_import.json.tables", "manifest.json")
    __resetCliDbForTesting()
    try {
      const legacy = await startDurability({
        home,
        accountId: "acct_import",
        backend: "snapshot-v3",
      })
      const { getDb } = await import("@/lib/db/schema")
      await getDb().sessions.put(session("legacy-session"))
      await legacy.dispose()
      const legacyManifestBytes = fs.readFileSync(tableManifest)
      await dropDatabase()

      const onLegacyImport = jest.fn()
      const migrated = await startDurability({
        home,
        accountId: "acct_import",
        env: {},
        onLegacyImport,
      })
      expect(migrated.backend).toBe("sqlite-v5")
      expect(onLegacyImport).toHaveBeenCalledTimes(1)
      expect(onLegacyImport.mock.calls[0][0]).toEqual(
        expect.objectContaining({ kind: "table-store" })
      )
      const db = (await import("@/lib/db/schema")).getDb()
      expect(await db.sessions.get("legacy-session")).toEqual(
        expect.objectContaining({ id: "legacy-session" })
      )
      await db.sessions.put(session("after-import"))
      await migrated.dispose()
      // The old store is a rollback source: byte-for-byte unchanged, unlocked.
      expect(fs.readFileSync(tableManifest).equals(legacyManifestBytes)).toBe(true)
      expect(fs.existsSync(path.join(home, "db-acct_import.json.lock"))).toBe(false)

      await dropDatabase()
      const reboot = await startDurability({
        home,
        accountId: "acct_import",
        env: {},
        onLegacyImport,
      })
      // Imported exactly once: the second boot restores from sqlite alone.
      expect(onLegacyImport).toHaveBeenCalledTimes(1)
      const rebooted = (await import("@/lib/db/schema")).getDb()
      expect(await rebooted.sessions.get("legacy-session")).toBeDefined()
      expect(await rebooted.sessions.get("after-import")).toBeDefined()
      await reboot.dispose()
    } finally {
      await dropDatabase().catch(() => {})
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
})

describe("startDurability on the journal rung", () => {
  it("journals live Dexie writes and reports the backend it armed", async () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "cognia-journal-rung-"))
    __resetCliDbForTesting()
    try {
      const handle = await startDurability({
        home,
        accountId: "acct_journal",
        backend: "journal-v4",
      })
      expect(handle.backend).toBe("journal-v4")
      expect(handle.db).toBeNull()
      // `notifyDbWrite` stays callable for `bootstrapHeadlessRuntimes`, but the
      // journal rung needs no explicit flush.
      expect(() => handle.notifyDbWrite()).not.toThrow()

      const { getDb } = await import("@/lib/db/schema")
      await getDb().sessions.put({
        id: "journalled-session",
        title: "journalled",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      } as never)

      const rss = handle.rss()
      expect(rss.rssBytes).toBeGreaterThan(0)
      expect(rss.lastFlushAt).toBeGreaterThan(0)
      await handle.dispose()

      const generations = fs.readdirSync(
        path.join(durabilityRoot(home, "acct_journal"), "generations")
      )
      expect(generations).toContain("gen-0001")
    } finally {
      __resetCliDbForTesting()
      fs.rmSync(home, { recursive: true, force: true })
    }
  })
})
