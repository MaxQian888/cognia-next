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
