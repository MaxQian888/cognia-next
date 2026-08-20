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
  clearAssignmentRoutingMarker,
  ASSIGNMENT_ROUTING_MARKER_CLEAR,
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

  it("markResponded and setStatus(resolved) reset the SLA escalation chain", async () => {
    await upsertByConversationKey({
      conversationKey: KEY,
      sessionId: "s1",
      nextResponseDueAt: 100,
      escalatedStep: 1,
      escalatedAt: 90,
    })
    await markResponded(KEY, 150)
    let row = await readForResolution(KEY)
    expect(row?.escalatedStep).toBeUndefined()
    expect(row?.escalatedAt).toBeUndefined()

    await upsertByConversationKey({
      conversationKey: KEY,
      sessionId: "s1",
      escalatedStep: 0,
      escalatedAt: 90,
    })
    await setStatus(KEY, "resolved", { sessionId: "s1" })
    row = await readForResolution(KEY)
    expect(row?.escalatedStep).toBeUndefined()
    expect(row?.escalatedAt).toBeUndefined()
    // Non-resolved transitions leave the chain alone.
    await upsertByConversationKey({ conversationKey: KEY, sessionId: "s1", escalatedStep: 2 })
    await setStatus(KEY, "pending", { sessionId: "s1" })
    expect((await readForResolution(KEY))?.escalatedStep).toBe(2)
  })

  describe("assignment ↔ routing sync (slice 1A)", () => {
    const AKEY = "telegram:adp_a:chat_assign"
    const auditRows = () =>
      getDb()
        .connectorAudit.filter((r) => r.conversationKey === AKEY)
        .toArray()

    it("keeps an operator's explicit /workflow off across an escalation and an unassign", async () => {
      // The walk that used to lose the operator's choice:
      //   reassign(team) -> switchMode(manual) -> /workflow off -> unassign
      // `/workflow` was the one arm that did not clear the assignment marker,
      // and `workflowDisabled` IS a ROUTING_SNAPSHOT_KEYS member — so unassign
      // ran `restoreRouting` and silently reinstated the pre-assignment value.
      const WKEY = "telegram:adp_a:chat_workflow_walk"
      await upsertByConversationKey({
        conversationKey: WKEY,
        sessionId: "s1",
        workflowId: "wf-old",
      })
      await setAssignee(WKEY, { kind: "team", id: "team-1" }, { via: "manual" })
      await updateConversationConfigSection({
        adapterId: "adp_a",
        conversationKey: WKEY,
        section: "behavior",
        patch: { mode: "manual", autonomy: "observe", modeForcedBy: "escalation" },
        source: "sla-escalation",
      })

      // The operator takes over explicitly — this is what must survive.
      await patchConversationOverride(WKEY, {
        workflowId: undefined,
        workflowDisabled: true,
        ...ASSIGNMENT_ROUTING_MARKER_CLEAR,
      })
      await setAssignee(WKEY, null, { via: "manual" })

      const row = await readForResolution(WKEY)
      expect(row?.workflowDisabled).toBe(true)
      expect(row?.workflowId).toBeUndefined()
      expect(row?.routingSource).toBeUndefined()
      // The escalation label goes with the explicit edit: attributing the
      // operator's own choice to the ladder would be worse than no label.
      expect(row?.modeForcedBy).toBeUndefined()
    })

    it("restores autonomy and engagement alongside the mode on unassign", async () => {
      const RKEY = "telegram:adp_a:chat_axis_restore"
      await upsertByConversationKey({
        conversationKey: RKEY,
        sessionId: "s1",
        mode: "auto",
        autonomy: "act",
        engagement: "inline",
      })
      await setAssignee(RKEY, { kind: "human", id: "u1" }, { via: "manual" })

      const assigned = await readForResolution(RKEY)
      expect(assigned?.mode).toBe("manual")
      expect(assigned?.engagement).toBe("human")
      expect(assigned?.autonomy).toBe("observe")

      await setAssignee(RKEY, null, { via: "manual" })
      const restored = await readForResolution(RKEY)
      expect(restored?.mode).toBe("auto")
      expect(restored?.autonomy).toBe("act")
      expect(restored?.engagement).toBe("inline")
    })

    it("assigning a character writes characterId + marker, snapshots the previous routing, and audits", async () => {
      await upsertByConversationKey({
        conversationKey: AKEY,
        sessionId: "s1",
        characterId: "char-old",
        teamDisabled: true,
      })
      await setAssignee(AKEY, { kind: "character", id: "char-new" }, { via: "manual" })
      const row = await readForResolution(AKEY)
      expect(row?.characterId).toBe("char-new")
      expect(row?.characterDisabled).toBeUndefined()
      expect(row?.routingSource).toBe("assignment")
      expect(row?.assignmentPreviousRouting).toEqual({
        characterId: "char-old",
        teamDisabled: true,
      })
      const audits = await auditRows()
      expect(audits).toHaveLength(1)
      expect(audits[0]).toMatchObject({
        adapterId: "adp_a",
        kind: "override.config_changed",
        fields: {
          source: "assignment",
          via: "manual",
          changedKeys: ["assignmentPreviousRouting", "characterId", "routingSource"],
        },
      })
      const trail = await listAssignmentEvents(AKEY)
      expect(trail.at(-1)?.fields?.routing).toEqual({ kind: "character", characterId: "char-new" })
    })

    it("assigning a character clears the characterDisabled sentinel and restores it on unassign", async () => {
      await upsertByConversationKey({
        conversationKey: AKEY,
        sessionId: "s1",
        characterDisabled: true,
      })
      await setAssignee(AKEY, { kind: "character", id: "char-1" })
      expect((await readForResolution(AKEY))?.characterDisabled).toBeUndefined()
      await setAssignee(AKEY, null)
      const row = await readForResolution(AKEY)
      expect(row?.characterDisabled).toBe(true)
      expect(row?.characterId).toBeUndefined()
      expect(row?.routingSource).toBeUndefined()
      expect(row?.assignmentPreviousRouting).toBeUndefined()
    })

    it("assigning a team writes teamId, clears teamDisabled, and character ⇄ team reassignment re-applies the snapshot", async () => {
      await upsertByConversationKey({
        conversationKey: AKEY,
        sessionId: "s1",
        teamDisabled: true,
      })
      await setAssignee(AKEY, { kind: "team", id: "team-1" })
      let row = await readForResolution(AKEY)
      expect(row?.teamId).toBe("team-1")
      expect(row?.teamDisabled).toBeUndefined()
      expect(row?.assignmentPreviousRouting).toEqual({ teamDisabled: true })

      // Reassign to a character: the assignment-written teamId must NOT keep
      // winning the routing — the snapshot is re-applied first.
      await setAssignee(AKEY, { kind: "character", id: "char-2" })
      row = await readForResolution(AKEY)
      expect(row?.teamId).toBeUndefined()
      expect(row?.teamDisabled).toBe(true)
      expect(row?.characterId).toBe("char-2")
      // Snapshot is taken once and preserved across reassignment.
      expect(row?.assignmentPreviousRouting).toEqual({ teamDisabled: true })

      await setAssignee(AKEY, null)
      row = await readForResolution(AKEY)
      expect(row?.characterId).toBeUndefined()
      expect(row?.teamDisabled).toBe(true)
      expect(row?.assignee).toBeUndefined()
    })

    it("assigning a human forces manual mode, records the previous mode, and unassign restores it", async () => {
      await upsertByConversationKey({ conversationKey: AKEY, sessionId: "s1", mode: "auto" })
      await setAssignee(AKEY, { kind: "human" }, { adapterId: "adp_explicit" })
      let row = await readForResolution(AKEY)
      expect(row?.mode).toBe("manual")
      expect(row?.assignmentPreviousMode).toBe("auto")
      const audits = await auditRows()
      expect(audits[0]?.adapterId).toBe("adp_explicit")
      // The axis fields are snapshotted and written alongside their legacy
      // mirror, so `human` becomes a visible engagement rather than an
      // unexplained Manual chip.
      expect(audits[0]?.fields?.changedKeys).toEqual([
        "assignmentPreviousAutonomy",
        "assignmentPreviousEngagement",
        "assignmentPreviousMode",
        "autonomy",
        "engagement",
        "mode",
      ])
      const trail = await listAssignmentEvents(AKEY)
      expect(trail.at(-1)?.fields?.routing).toEqual({ kind: "manual-mode", mode: "manual" })

      await setAssignee(AKEY, null)
      row = await readForResolution(AKEY)
      expect(row?.mode).toBe("auto")
      expect(row?.assignmentPreviousMode).toBeUndefined()
      const restored = (await listAssignmentEvents(AKEY)).at(-1)
      expect(restored?.kind).toBe("unassigned")
      expect(restored?.fields?.routing).toMatchObject({ kind: "restored", mode: "auto" })
    })

    it("human assignment on a row without an explicit mode records null and restores inherit", async () => {
      await upsertByConversationKey({ conversationKey: AKEY, sessionId: "s1" })
      await setAssignee(AKEY, { kind: "human" })
      let row = await readForResolution(AKEY)
      expect(row?.mode).toBe("manual")
      expect(row?.assignmentPreviousMode).toBeNull()
      // Reassigning to a character hands the mode back (AI target replies).
      await setAssignee(AKEY, { kind: "character", id: "char-3" })
      row = await readForResolution(AKEY)
      expect(row?.mode).toBeUndefined()
      expect(row?.assignmentPreviousMode).toBeUndefined()
      expect(row?.characterId).toBe("char-3")
      const trail = await listAssignmentEvents(AKEY)
      expect(trail.at(-1)?.fields?.routing).toEqual({
        kind: "character",
        characterId: "char-3",
        mode: null,
      })
    })

    it("unassign after an explicit routing edit (marker cleared) does NOT restore the snapshot", async () => {
      await upsertByConversationKey({
        conversationKey: AKEY,
        sessionId: "s1",
        characterId: "char-old",
      })
      await setAssignee(AKEY, { kind: "character", id: "char-assigned" })
      // Operator edits routing by hand → the form / command clears the marker.
      await patchConversationOverride(AKEY, {
        characterId: "char-manual",
        ...ASSIGNMENT_ROUTING_MARKER_CLEAR,
      })
      await setAssignee(AKEY, null)
      const row = await readForResolution(AKEY)
      expect(row?.characterId).toBe("char-manual")
      expect(row?.assignee).toBeUndefined()
      const trail = await listAssignmentEvents(AKEY)
      expect(trail.at(-1)?.kind).toBe("unassigned")
      expect(trail.at(-1)?.fields?.routing).toBeUndefined()
    })

    it("clearAssignmentRoutingMarker drops the marker but keeps the assignee (no-op without marker / row)", async () => {
      await expect(clearAssignmentRoutingMarker("never:seen:key")).resolves.toBeUndefined()
      await upsertByConversationKey({ conversationKey: AKEY, sessionId: "s1" })
      const before = await readForResolution(AKEY)
      await clearAssignmentRoutingMarker(AKEY)
      expect((await readForResolution(AKEY))?.updatedAt).toBe(before?.updatedAt)

      await setAssignee(AKEY, { kind: "human" })
      await clearAssignmentRoutingMarker(AKEY)
      const row = await readForResolution(AKEY)
      expect(row?.assignee).toEqual({ kind: "human" })
      expect(row?.mode).toBe("manual")
      expect(row?.assignmentPreviousMode).toBeUndefined()
      expect(row?.routingSource).toBeUndefined()
    })

    it("skips the audit row (but still syncs) when the adapter id cannot be resolved", async () => {
      await upsertByConversationKey({ conversationKey: "opaque-key", sessionId: "s1" })
      await setAssignee("opaque-key", { kind: "character", id: "char-9" })
      const row = await readForResolution("opaque-key")
      expect(row?.characterId).toBe("char-9")
      expect(
        await getDb()
          .connectorAudit.filter((r) => r.conversationKey === "opaque-key")
          .count()
      ).toBe(0)
    })

    it("no routing/mode change → no audit row and no routing field on the trail", async () => {
      await upsertByConversationKey({ conversationKey: AKEY, sessionId: "s1" })
      await setAssignee(AKEY, null)
      expect(await auditRows()).toHaveLength(0)
      const trail = await listAssignmentEvents(AKEY)
      expect(trail).toHaveLength(1)
      expect(trail[0].fields?.routing).toBeUndefined()
    })
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
