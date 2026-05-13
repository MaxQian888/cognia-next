/**
 * @jest-environment jsdom
 */
import "fake-indexeddb/auto"
import { __resetDbForTesting, getDb, whenSeeded } from "@/lib/db/schema"
import { approveDraft, createDraft, rejectDraft } from "@/lib/db/connector-drafts"
import { conversationKeyForApproval, requestHitlApproval } from "./draft-bridge"

beforeEach(async () => {
  await getDb().delete()
  __resetDbForTesting()
  getDb()
  await whenSeeded()
  await getDb().connectorDrafts.clear()
})

describe("conversationKeyForApproval", () => {
  it("namespaces by runId + stepId", () => {
    expect(conversationKeyForApproval("run_1", "step_a")).toBe("gh:approval:run_1:step_a")
  })
})

describe("requestHitlApproval", () => {
  it("creates a pending draft and resolves with the edited body on approve", async () => {
    const ac = new AbortController()
    const promise = requestHitlApproval({
      runId: "run_x",
      stepId: "step_merge",
      repoFullName: "octocat/hello",
      actionSummary: "Merge PR #42",
      proposedBody: "Looks good to me",
      pollIntervalMs: 20,
      signal: ac.signal,
    })

    // Give the bridge a tick to create the draft.
    await new Promise((r) => setTimeout(r, 30))
    const pending = await getDb().connectorDrafts.toArray()
    expect(pending).toHaveLength(1)
    expect(pending[0].conversationKey).toBe("gh:approval:run_x:step_merge")
    expect(pending[0].sessionId).toBe("run_x")
    expect(pending[0].status).toBe("pending")

    // Simulate the user editing the body, then approving.
    await getDb().connectorDrafts.update(pending[0].id, {
      segments: [
        { type: "text", text: "[cognia GitHub Delivery] Merge PR #42" },
        { type: "text", text: "Edited reply" },
      ],
    })
    await approveDraft(pending[0].id)

    const result = await promise
    expect(result.outcome).toBe("approve")
    expect(result.editedBody).toBe("Edited reply")
    expect(result.draftId).toBe(pending[0].id)
  })

  it("resolves with reject when the user rejects", async () => {
    const ac = new AbortController()
    const promise = requestHitlApproval({
      runId: "run_y",
      stepId: "step_close",
      repoFullName: "octocat/hello",
      actionSummary: "Close issue #5",
      pollIntervalMs: 20,
      signal: ac.signal,
    })
    await new Promise((r) => setTimeout(r, 30))
    const drafts = await getDb().connectorDrafts.toArray()
    await rejectDraft(drafts[0].id)
    const result = await promise
    expect(result.outcome).toBe("reject")
    expect(result.editedBody).toBeUndefined()
  })

  it("returns reject with feedback when the draft expires", async () => {
    const ac = new AbortController()
    const promise = requestHitlApproval({
      runId: "run_e",
      stepId: "step_a",
      repoFullName: "octocat/hello",
      actionSummary: "Merge PR #1",
      pollIntervalMs: 20,
      signal: ac.signal,
    })
    await new Promise((r) => setTimeout(r, 30))
    const [draft] = await getDb().connectorDrafts.toArray()
    await getDb().connectorDrafts.update(draft.id, { status: "expired" })
    const result = await promise
    expect(result.outcome).toBe("reject")
    expect(result.feedback).toMatch(/expired/)
  })

  it("returns reject when the draft is deleted out from under us", async () => {
    const ac = new AbortController()
    const promise = requestHitlApproval({
      runId: "run_d",
      stepId: "step_a",
      repoFullName: "octocat/hello",
      actionSummary: "Comment",
      pollIntervalMs: 20,
      signal: ac.signal,
    })
    await new Promise((r) => setTimeout(r, 30))
    const [draft] = await getDb().connectorDrafts.toArray()
    await getDb().connectorDrafts.delete(draft.id)
    const result = await promise
    expect(result.outcome).toBe("reject")
    expect(result.feedback).toMatch(/deleted/)
  })

  it("throws when the surrounding signal aborts mid-wait", async () => {
    const ac = new AbortController()
    const promise = requestHitlApproval({
      runId: "run_ab",
      stepId: "step_a",
      repoFullName: "octocat/hello",
      actionSummary: "x",
      pollIntervalMs: 20,
      signal: ac.signal,
    })
    await new Promise((r) => setTimeout(r, 30))
    ac.abort()
    await expect(promise).rejects.toThrow(/cancelled/)
  })

  it("reuses an existing pending draft for the same (runId, stepId) — supports resume", async () => {
    // Pre-existing draft as if a prior process wrote it before crashing.
    await createDraft({
      conversationKey: conversationKeyForApproval("run_resume", "step_x"),
      sessionId: "run_resume",
      segments: [{ type: "text", text: "[old]" }],
      sourceMessageId: "step_x",
    })

    const ac = new AbortController()
    const promise = requestHitlApproval({
      runId: "run_resume",
      stepId: "step_x",
      repoFullName: "o/r",
      actionSummary: "merge",
      pollIntervalMs: 20,
      signal: ac.signal,
    })
    await new Promise((r) => setTimeout(r, 30))
    const rows = await getDb().connectorDrafts.toArray()
    expect(rows).toHaveLength(1) // No duplicate created.
    await approveDraft(rows[0].id)
    const result = await promise
    expect(result.outcome).toBe("approve")
  })
})
