/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"

import type { Transport } from "@/lib/tauri/transport-types"
import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"

import { RETRIEVAL_CONTENT_PROTOCOL_VERSION } from "./base"
import { syncMcpServers } from "./mcp-servers"

function makeTransport(): Transport {
  return {
    call: jest.fn(async () => ({
      rows: [],
      deleted_ids: [],
      next_since: 12,
    })) as unknown as Transport["call"],
    subscribe: jest.fn(() => () => {}) as unknown as Transport["subscribe"],
  }
}

describe("syncMcpServers", () => {
  const dbFixture = createDbTestFixture()

  beforeAll(dbFixture.initialize)
  beforeEach(dbFixture.restore)
  afterAll(dbFixture.dispose)

  it("calls sync_pull with table=mcpServers", async () => {
    const tx = makeTransport()
    const out = await syncMcpServers(tx, { since: 0 })

    expect(tx.call).toHaveBeenCalledWith("sync_pull", {
      table: "mcpServers",
      since: 0,
      content_protocol_version: RETRIEVAL_CONTENT_PROTOCOL_VERSION,
    })
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.result.nextSince).toBe(12)
  })

  it("persists only the redacted mobile projection from legacy full rows", async () => {
    const tx = makeTransport()
    ;(tx.call as jest.Mock).mockResolvedValueOnce({
      rows: [
        {
          id: "mcp-1",
          name: "github",
          displayName: "GitHub",
          transport: "http",
          enabled: true,
          updatedAt: 12,
          config: { headers: { Authorization: "secret" } },
        },
      ],
      deleted_ids: [],
      next_since: 12,
    })

    await syncMcpServers(tx, { since: 0 })
    expect(await getDb().mcpServerSummaries.get("mcp-1")).toEqual({
      id: "mcp-1",
      displayName: "GitHub",
      transport: "http",
      enabled: true,
      trustState: "legacy",
      updatedAt: 12,
    })
  })
})
