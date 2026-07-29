/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"

import { getDb } from "@/lib/db/schema"
import type { Transport } from "@/lib/tauri/transport-types"
import type { SyncDelta } from "../types"

import { syncAppSettings, CROSS_PLATFORM_SETTING_KEYS } from "./app-settings"

function makeTransport(delta: SyncDelta<{ id: string }>): Transport {
  return {
    call: jest.fn(async () => delta) as unknown as Transport["call"],
    subscribe: jest.fn(() => () => {}) as unknown as Transport["subscribe"],
  }
}

describe("syncAppSettings", () => {
  beforeEach(async () => {
    await getDb().settings.clear()
  })

  it("calls sync_pull with table=settings", async () => {
    const tx = makeTransport({ rows: [], deleted_ids: [], next_since: 4 })
    const out = await syncAppSettings(tx, { since: 0 })
    expect(tx.call).toHaveBeenCalledWith("sync_pull", { table: "settings", since: 0 })
    expect(out.ok).toBe(true)
  })

  it("writes the cross-platform fields from the delta", async () => {
    const tx = makeTransport({
      rows: [{ id: "singleton", theme: "dark" } as never],
      deleted_ids: [],
      next_since: 7,
    })
    const out = await syncAppSettings(tx, { since: 0 })
    expect(out.ok).toBe(true)
    expect((await getDb().settings.get("singleton"))?.theme).toBe("dark")
  })

  it("merges only cross-platform fields, preserving device-local ones", async () => {
    await getDb().settings.put({
      id: "singleton",
      alwaysAllowTools: [],
      builtinTools: {},
      apiKey: "phone-secret",
      theme: "light",
    } as never)

    const tx = makeTransport({
      rows: [
        { id: "singleton", theme: "dark", defaultModel: "opus", apiKey: "desktop-key" } as never,
      ],
      deleted_ids: [],
      next_since: 10,
    })
    await syncAppSettings(tx, { since: 0 })

    const row = await getDb().settings.get("singleton")
    expect(row?.theme).toBe("dark") // allowlisted → applied
    expect(row?.defaultModel).toBe("opus") // allowlisted → applied
    expect(row?.apiKey).toBe("phone-secret") // device-local → preserved
  })

  it("no-ops on an empty delta (settings already warm)", async () => {
    await getDb().settings.put({ id: "singleton", theme: "light" } as never)
    const out = await syncAppSettings(makeTransport({ rows: [], deleted_ids: [], next_since: 0 }), {
      since: 5,
    })
    expect(out.ok).toBe(true)
    expect((await getDb().settings.get("singleton"))?.theme).toBe("light")
  })

  it("excludes device-local keys from the cross-platform allowlist", () => {
    expect(CROSS_PLATFORM_SETTING_KEYS).toContain("theme")
    expect(CROSS_PLATFORM_SETTING_KEYS).not.toContain("apiKey" as never)
    expect(CROSS_PLATFORM_SETTING_KEYS).not.toContain("defaultWorkingDir" as never)
  })

  it("mirrors transport config down so a self-hosted signaling server reaches this client", () => {
    // These used to be writable up and never mirrored down, so the client read
    // its own empty copy, fell back to the public default, and could not reach
    // an operator's own signaling server or TURN relay at all.
    expect(CROSS_PLATFORM_SETTING_KEYS).toContain("signalingUrl")
    expect(CROSS_PLATFORM_SETTING_KEYS).toContain("iceServers")
    expect(CROSS_PLATFORM_SETTING_KEYS).toContain("turnServers")
    expect(CROSS_PLATFORM_SETTING_KEYS).toContain("remoteBrowserEnabled")
  })

  describe("with an edit still in the outbound queue", () => {
    async function queue(status: string, patch: Record<string, unknown>) {
      await getDb().mobileOutboundQueue.put({
        id: `job-${status}-${Object.keys(patch).join("-")}`,
        command: "app_settings_update",
        payload: { patch },
        status,
        attempts: 0,
        createdAt: 1,
        nextAttemptAt: 1,
        idempotencyKey: `idem-${status}-${Object.keys(patch).join("-")}`,
      } as never)
    }

    beforeEach(async () => {
      await getDb().mobileOutboundQueue.clear()
    })

    it("does not overwrite a key whose write has not reached the host yet", async () => {
      // Editing settings offline used to look broken: the local write landed,
      // the job queued, and the first pull after reconnecting replaced it with
      // the host's older value — so the UI snapped back, then changed again
      // once the queue drained.
      await getDb().settings.put({ id: "singleton", theme: "dark", fontScale: "lg" } as never)
      await queue("pending", { theme: "dark" })

      const tx = makeTransport({
        rows: [{ id: "singleton", theme: "light", fontScale: "sm" } as never],
        deleted_ids: [],
        next_since: 20,
      })
      await syncAppSettings(tx, { since: 0 })

      const row = await getDb().settings.get("singleton")
      expect(row?.theme).toBe("dark") // in flight → left alone
      expect(row?.fontScale).toBe("sm") // untouched by the queue → mirrored
    })

    it.each(["sending", "failed"])("also masks a %s write", async (status) => {
      await getDb().settings.put({ id: "singleton", theme: "dark" } as never)
      await queue(status, { theme: "dark" })

      await syncAppSettings(
        makeTransport({
          rows: [{ id: "singleton", theme: "light" } as never],
          deleted_ids: [],
          next_since: 20,
        }),
        { since: 0 }
      )
      expect((await getDb().settings.get("singleton"))?.theme).toBe("dark")
    })

    it.each(["sent", "deadlettered"])(
      "lets the host value land once the write is %s",
      async (status) => {
        // `sent` already reached the host, so its delta is the newer truth.
        // `deadlettered` will never be retried — masking it forever would pin
        // this client to a value the host is never going to hold.
        await getDb().settings.put({ id: "singleton", theme: "dark" } as never)
        await queue(status, { theme: "dark" })

        await syncAppSettings(
          makeTransport({
            rows: [{ id: "singleton", theme: "light" } as never],
            deleted_ids: [],
            next_since: 20,
          }),
          { since: 0 }
        )
        expect((await getDb().settings.get("singleton"))?.theme).toBe("light")
      }
    )

    it("ignores queued jobs that are not settings writes", async () => {
      await getDb().settings.put({ id: "singleton", theme: "dark" } as never)
      await getDb().mobileOutboundQueue.put({
        id: "job-other",
        command: "workflow_trigger_manual",
        payload: { patch: { theme: "whatever" } },
        status: "pending",
        attempts: 0,
        createdAt: 1,
        nextAttemptAt: 1,
        idempotencyKey: "idem-other",
      } as never)

      await syncAppSettings(
        makeTransport({
          rows: [{ id: "singleton", theme: "light" } as never],
          deleted_ids: [],
          next_since: 20,
        }),
        { since: 0 }
      )
      expect((await getDb().settings.get("singleton"))?.theme).toBe("light")
    })
  })
})
