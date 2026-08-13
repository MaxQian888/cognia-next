/**
 * Tests for lib/db/conversation-overrides.ts — per-conversation settings CRUD.
 */

import {
  upsertByConversationKey,
  readForResolution,
  patchConversationOverride,
  updateConversationConfigSection,
  setPinned,
  setArchived,
  effectiveStatus,
  setStatus,
  wakeSnoozedConversations,
  setAssignee,
  addLabel,
  removeLabel,
  setSlaDue,
  markResponded,
} from "./conversation-overrides"
import { listAssignmentEvents } from "./conversation-assignment-events"
import { getDb } from "./schema"
import { createDbTestFixture } from "./test-fixture"

const dbFixture = createDbTestFixture()

beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)

function baseInput() {
  return {
    conversationKey: "telegram:adp_1:chat_123",
    sessionId: "sess_abc",
    mode: "auto" as const,
  }
}

describe("conversation-overrides", () => {
  it("upsertByConversationKey creates a new row", async () => {
    const row = await upsertByConversationKey(baseInput())
    expect(row.id).toMatch(/^cov_/)
    expect(row.conversationKey).toBe("telegram:adp_1:chat_123")
    expect(row.sessionId).toBe("sess_abc")
    expect(row.createdAt).toBeGreaterThan(0)
    expect(row.updatedAt).toBe(row.createdAt)
  })

  it("upsertByConversationKey is idempotent — same key returns same id", async () => {
    const first = await upsertByConversationKey(baseInput())
    const second = await upsertByConversationKey({ ...baseInput(), mode: "manual" })
    expect(second.id).toBe(first.id)
    expect(second.mode).toBe("manual")
  })

  it("upsertByConversationKey bumps updatedAt on re-upsert", async () => {
    const first = await upsertByConversationKey(baseInput())
    await new Promise((r) => setTimeout(r, 2))
    const second = await upsertByConversationKey(baseInput())
    expect(second.updatedAt).toBeGreaterThan(first.updatedAt)
  })

  it("readForResolution returns the row for a key", async () => {
    await upsertByConversationKey(baseInput())
    const found = await readForResolution("telegram:adp_1:chat_123")
    expect(found).toBeDefined()
    expect(found?.conversationKey).toBe("telegram:adp_1:chat_123")
  })

  it("readForResolution returns undefined for unknown key", async () => {
    expect(await readForResolution("unknown:key")).toBeUndefined()
  })

  describe("patchConversationOverride", () => {
    it("creates the row (with sessionId) and applies the patch", async () => {
      const row = await patchConversationOverride(
        "telegram:adp_1:chat_777",
        { reasoningOverride: "high", teamId: "team_a" },
        "sess_new"
      )
      expect(row.id).toMatch(/^cov_/)
      expect(row.sessionId).toBe("sess_new")
      expect(row.reasoningOverride).toBe("high")
      expect(row.teamId).toBe("team_a")
    })

    it("merges into an existing row without a sessionId and bumps updatedAt", async () => {
      const created = await upsertByConversationKey(baseInput())
      await new Promise((r) => setTimeout(r, 2))
      const patched = await patchConversationOverride("telegram:adp_1:chat_123", {
        approvalMode: "yolo",
        proactivePush: true,
      })
      expect(patched.id).toBe(created.id)
      expect(patched.mode).toBe("auto") // untouched
      expect(patched.approvalMode).toBe("yolo")
      expect(patched.proactivePush).toBe(true)
      expect(patched.updatedAt).toBeGreaterThan(created.updatedAt)
    })

    it("throws when the row is absent and no sessionId is supplied", async () => {
      await expect(
        patchConversationOverride("telegram:adp_1:absent", { activeSessionId: "s1" })
      ).rejects.toThrow(/no sessionId/)
    })

    it("sets activeSessionId for /switch", async () => {
      await upsertByConversationKey(baseInput())
      const patched = await patchConversationOverride("telegram:adp_1:chat_123", {
        activeSessionId: "sess_switched",
      })
      expect(patched.activeSessionId).toBe("sess_switched")
    })

    it("binds and clears workflowId for /workflow", async () => {
      await upsertByConversationKey(baseInput())
      const bound = await patchConversationOverride("telegram:adp_1:chat_123", {
        workflowId: "wf_n",
      })
      expect(bound.workflowId).toBe("wf_n")
      const cleared = await patchConversationOverride("telegram:adp_1:chat_123", {
        workflowId: undefined,
      })
      expect(cleared.workflowId).toBeUndefined()
    })
  })

  it("atomically saves a configuration section and audit metadata", async () => {
    await upsertByConversationKey({
      conversationKey: "telegram:adp_1:chat_999",
      sessionId: "sess_999",
    })
    const row = await updateConversationConfigSection({
      adapterId: "adp_1",
      conversationKey: "telegram:adp_1:chat_999",
      sessionId: "sess_999",
      section: "responder",
      patch: { workflowId: "wf_prod", teamDisabled: true },
    })
    expect(row).toMatchObject({ workflowId: "wf_prod", teamDisabled: true })
    const audit = await getDb()
      .connectorAudit.where("adapterId")
      .equals("adp_1")
      .filter((entry) => entry.conversationKey === "telegram:adp_1:chat_999")
      .first()
    expect(audit).toMatchObject({
      adapterId: "adp_1",
      kind: "override.config_changed",
      fields: {
        scope: "conversation",
        section: "responder",
        changedKeys: ["teamDisabled", "workflowId"],
        source: "inbox",
      },
    })
  })

  it("setPinned sets pinned=true and bumps updatedAt", async () => {
    const row = await upsertByConversationKey(baseInput())
    await new Promise((r) => setTimeout(r, 2))
    await setPinned(row.id, true)
    const updated = await getDb().conversationOverrides.get(row.id)
    expect(updated?.pinned).toBe(true)
    expect(updated?.updatedAt).toBeGreaterThan(row.updatedAt)
  })

  it("setPinned sets pinned=false (unpin)", async () => {
    const row = await upsertByConversationKey(baseInput())
    await setPinned(row.id, true)
    await setPinned(row.id, false)
    const updated = await getDb().conversationOverrides.get(row.id)
    expect(updated?.pinned).toBe(false)
  })

  it("setArchived sets archived=true", async () => {
    const row = await upsertByConversationKey(baseInput())
    await setArchived(row.id, true)
    const updated = await getDb().conversationOverrides.get(row.id)
    expect(updated?.archived).toBe(true)
  })

  it("setArchived sets archived=false", async () => {
    const row = await upsertByConversationKey(baseInput())
    await setArchived(row.id, true)
    await setArchived(row.id, false)
    const updated = await getDb().conversationOverrides.get(row.id)
    expect(updated?.archived).toBe(false)
  })

  it("optional fields (characterId, trigger, lastReadAt) round-trip", async () => {
    const row = await upsertByConversationKey({
      ...baseInput(),
      characterId: "char_1",
      lastReadAt: 12345,
    })
    expect(row.characterId).toBe("char_1")
    expect(row.lastReadAt).toBe(12345)
  })

  // ── v43 / ADR-0026 — built-in skill gating fields ─────────────────
  it("allowedBuiltInSkillIds: string[] round-trips", async () => {
    const row = await upsertByConversationKey({
      ...baseInput(),
      allowedBuiltInSkillIds: ["lark.calendar.list_events", "lark.doc.search"],
    })
    expect(row.allowedBuiltInSkillIds).toEqual(["lark.calendar.list_events", "lark.doc.search"])
  })

  it("allowedBuiltInSkillIds: 'all' sentinel round-trips", async () => {
    const row = await upsertByConversationKey({
      ...baseInput(),
      allowedBuiltInSkillIds: "all",
    })
    expect(row.allowedBuiltInSkillIds).toBe("all")
  })

  it("allowedBuiltInSkillIds: [] (block-all) round-trips", async () => {
    const row = await upsertByConversationKey({
      ...baseInput(),
      allowedBuiltInSkillIds: [],
    })
    expect(row.allowedBuiltInSkillIds).toEqual([])
  })

  it("requireHitlForWrites: false round-trips (default-allow channel)", async () => {
    const row = await upsertByConversationKey({
      ...baseInput(),
      requireHitlForWrites: false,
    })
    expect(row.requireHitlForWrites).toBe(false)
  })

  it("requireHitlForWrites: true round-trips", async () => {
    const row = await upsertByConversationKey({
      ...baseInput(),
      requireHitlForWrites: true,
    })
    expect(row.requireHitlForWrites).toBe(true)
  })

  it("v43 gate fields preserved across upsert that touches unrelated fields", async () => {
    const first = await upsertByConversationKey({
      ...baseInput(),
      allowedBuiltInSkillIds: ["lark.task.list"],
      requireHitlForWrites: false,
    })
    const second = await upsertByConversationKey({
      ...baseInput(),
      mode: "manual",
      allowedBuiltInSkillIds: first.allowedBuiltInSkillIds,
      requireHitlForWrites: first.requireHitlForWrites,
    })
    expect(second.id).toBe(first.id)
    expect(second.allowedBuiltInSkillIds).toEqual(["lark.task.list"])
    expect(second.requireHitlForWrites).toBe(false)
  })
})

describe("conversation-overrides — CRM (v83)", () => {
  const KEY = "discord:adp_1:ch_crm"

  it("effectiveStatus defaults a missing/absent status to open", async () => {
    expect(effectiveStatus(undefined)).toBe("open")
    const row = await upsertByConversationKey({ conversationKey: KEY, sessionId: "s1" })
    expect(effectiveStatus(row)).toBe("open")
  })

  it("setStatus auto-creates the row, persists status, and emits a trail entry", async () => {
    await setStatus(KEY, "resolved", { sessionId: "s1" })
    const row = await readForResolution(KEY)
    expect(row?.status).toBe("resolved")
    const trail = await listAssignmentEvents(KEY)
    expect(trail.at(-1)).toMatchObject({ kind: "status.resolved" })
  })

  it("setStatus throws when the row is absent and no sessionId is given", async () => {
    await expect(setStatus("never:seen", "pending")).rejects.toThrow(/sessionId/)
  })

  it("setStatus does not emit a trail entry when the status is unchanged", async () => {
    await upsertByConversationKey({ conversationKey: KEY, sessionId: "s1", status: "open" })
    await setStatus(KEY, "open", { sessionId: "s1" })
    expect(await listAssignmentEvents(KEY)).toHaveLength(0)
  })

  it("snooze stores snoozeUntil and wakeSnoozedConversations reopens elapsed ones", async () => {
    await setStatus(KEY, "snoozed", { sessionId: "s1", snoozeUntil: 1000 })
    expect((await readForResolution(KEY))?.snoozeUntil).toBe(1000)

    const wokeNone = await wakeSnoozedConversations(500)
    expect(wokeNone).toBe(0)
    expect((await readForResolution(KEY))?.status).toBe("snoozed")

    const woke = await wakeSnoozedConversations(2000)
    expect(woke).toBe(1)
    const row = await readForResolution(KEY)
    expect(row?.status).toBe("open")
    expect(row?.snoozeUntil).toBeUndefined()
  })

  it("setAssignee emits assigned → reassigned → unassigned and mirrors assigneeKind", async () => {
    await setAssignee(KEY, { kind: "character", id: "char-1" }, { sessionId: "s1" })
    let row = await readForResolution(KEY)
    expect(row?.assigneeKind).toBe("character")

    await setAssignee(KEY, { kind: "team", id: "team-1" }, { sessionId: "s1" })
    await setAssignee(KEY, null, { sessionId: "s1" })
    row = await readForResolution(KEY)
    expect(row?.assignee).toBeUndefined()
    expect(row?.assigneeKind).toBeUndefined()

    const kinds = (await listAssignmentEvents(KEY)).map((e) => e.kind)
    expect(kinds).toEqual(["assigned", "reassigned", "unassigned"])
  })

  it("addLabel / removeLabel are idempotent and emit label events", async () => {
    await addLabel(KEY, "lbl-1", "s1")
    await addLabel(KEY, "lbl-1", "s1") // no-op
    await addLabel(KEY, "lbl-2", "s1")
    expect((await readForResolution(KEY))?.labelIds).toEqual(["lbl-1", "lbl-2"])

    await removeLabel(KEY, "lbl-1", "s1")
    await removeLabel(KEY, "lbl-1", "s1") // no-op
    expect((await readForResolution(KEY))?.labelIds).toEqual(["lbl-2"])

    const kinds = (await listAssignmentEvents(KEY)).map((e) => e.kind)
    expect(kinds).toEqual(["label.added", "label.added", "label.removed"])
  })

  it("setSlaDue sets timers and markResponded clears next + stamps first response once", async () => {
    await setSlaDue(KEY, { firstResponseDueAt: 100, nextResponseDueAt: 200 }, "s1")
    let row = await readForResolution(KEY)
    expect(row).toMatchObject({ firstResponseDueAt: 100, nextResponseDueAt: 200 })

    await markResponded(KEY, 150)
    row = await readForResolution(KEY)
    expect(row?.nextResponseDueAt).toBeUndefined()
    expect(row?.firstRespondedAt).toBe(150)

    // A later response does not overwrite firstRespondedAt.
    await setSlaDue(KEY, { nextResponseDueAt: 300 }, "s1")
    await markResponded(KEY, 400)
    expect((await readForResolution(KEY))?.firstRespondedAt).toBe(150)
  })

  it("markResponded is a no-op when no override row exists", async () => {
    await expect(markResponded("absent:key")).resolves.toBeUndefined()
  })

  describe("workspace (project) scoping", () => {
    it("stamps a new override row with the session's projectId", async () => {
      await getDb().sessions.put({
        id: "ses_ov",
        projectId: "proj-A",
        title: "a",
        updatedAt: 1,
        createdAt: 1,
      } as never)
      const row = await upsertByConversationKey({
        conversationKey: "slack:c:u",
        sessionId: "ses_ov",
      })
      expect(row.projectId).toBe("proj-A")
    })
  })
})
