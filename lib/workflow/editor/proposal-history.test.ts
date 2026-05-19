// Coverage for workflow-proposal-history CRUD. Uses fake-indexeddb so we
// exercise the actual Dexie path.

import "fake-indexeddb/auto"
import {
  PROPOSAL_HISTORY_LIMIT,
  appendProposalHistory,
  deleteProposalHistoryForWorkflow,
  listProposalHistory,
  pruneOldProposalHistory,
} from "./proposal-history"
import { getDb, whenSeeded, __resetDbForTesting } from "@/lib/db/schema"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
})

function makeRow(workflowId: string, idx: number, status: "applied" | "discarded" = "applied") {
  return {
    workflowId,
    proposalId: `p_${workflowId}_${idx}`,
    status,
    summary: `Op #${idx}`,
    opsCount: 1,
    affectedNodeIds: [`n${idx}`],
    messageId: `msg_${idx}`,
    createdAt: idx,
  }
}

describe("appendProposalHistory", () => {
  it("inserts a row and returns it with a derived id", async () => {
    const row = await appendProposalHistory(makeRow("wf_a", 1))
    expect(row.id).toBe("p_wf_a_1:applied")
    const fetched = await getDb().workflowProposalHistory.get(row.id)
    expect(fetched?.summary).toBe("Op #1")
  })

  it("upserts when the same proposal transitions a second time", async () => {
    await appendProposalHistory(makeRow("wf_a", 1, "applied"))
    await appendProposalHistory(makeRow("wf_a", 1, "discarded"))
    const all = await listProposalHistory("wf_a")
    expect(all).toHaveLength(2)
    expect(all.map((r) => r.status).sort()).toEqual(["applied", "discarded"])
  })
})

describe("listProposalHistory", () => {
  it("returns newest-first within one workflow only", async () => {
    await appendProposalHistory(makeRow("wf_a", 1))
    await appendProposalHistory(makeRow("wf_a", 3))
    await appendProposalHistory(makeRow("wf_a", 2))
    await appendProposalHistory(makeRow("wf_b", 99))
    const a = await listProposalHistory("wf_a")
    expect(a.map((r) => r.createdAt)).toEqual([3, 2, 1])
    const b = await listProposalHistory("wf_b")
    expect(b).toHaveLength(1)
    expect(b[0].createdAt).toBe(99)
  })

  it("respects the explicit limit argument", async () => {
    for (let i = 1; i <= 5; i++) await appendProposalHistory(makeRow("wf_a", i))
    const top2 = await listProposalHistory("wf_a", 2)
    expect(top2.map((r) => r.createdAt)).toEqual([5, 4])
  })
})

describe("pruneOldProposalHistory", () => {
  it(`keeps at most PROPOSAL_HISTORY_LIMIT (${PROPOSAL_HISTORY_LIMIT}) per workflow`, async () => {
    // Write LIMIT+5 rows; append already prunes after every insert.
    for (let i = 1; i <= PROPOSAL_HISTORY_LIMIT + 5; i++) {
      await appendProposalHistory(makeRow("wf_a", i))
    }
    const after = await listProposalHistory("wf_a", PROPOSAL_HISTORY_LIMIT + 5)
    expect(after).toHaveLength(PROPOSAL_HISTORY_LIMIT)
    // Oldest rows (1..5) were dropped, newest (LIMIT+5..6) survived.
    expect(after[0].createdAt).toBe(PROPOSAL_HISTORY_LIMIT + 5)
    expect(after[after.length - 1].createdAt).toBe(6)
  })

  it("is a no-op when the table is under the limit", async () => {
    await appendProposalHistory(makeRow("wf_a", 1))
    const removed = await pruneOldProposalHistory("wf_a")
    expect(removed).toBe(0)
  })

  it("scopes pruning per workflow (does not delete rows from other workflows)", async () => {
    for (let i = 1; i <= PROPOSAL_HISTORY_LIMIT + 1; i++) {
      await appendProposalHistory(makeRow("wf_a", i))
    }
    await appendProposalHistory(makeRow("wf_b", 1))
    const b = await listProposalHistory("wf_b")
    expect(b).toHaveLength(1)
  })
})

describe("deleteProposalHistoryForWorkflow", () => {
  it("removes every row for one workflow only", async () => {
    await appendProposalHistory(makeRow("wf_a", 1))
    await appendProposalHistory(makeRow("wf_a", 2))
    await appendProposalHistory(makeRow("wf_b", 1))
    const removed = await deleteProposalHistoryForWorkflow("wf_a")
    expect(removed).toBe(2)
    expect(await listProposalHistory("wf_a")).toHaveLength(0)
    expect(await listProposalHistory("wf_b")).toHaveLength(1)
  })
})
