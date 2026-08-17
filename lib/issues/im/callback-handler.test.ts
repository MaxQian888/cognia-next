/**
 * @jest-environment jsdom
 */

const mockFindSession = jest.fn(
  async (_key: string): Promise<{ id: string } | undefined> => undefined
)
jest.mock("@/lib/connectors/session-bindings", () => ({
  findSessionByConversationKey: (key: string) => mockFindSession(key),
}))

import type { ConnectorCallbackBindingRow } from "@/types/connectors/interaction"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { patchConversationOverride, readForResolution } from "@/lib/db/conversation-overrides"
import { createIssueProject } from "@/lib/db/issue-projects"
import { createIssue, getIssue } from "@/lib/db/issues"
import { getDb } from "@/lib/db/schema"
import { recordCallbackBinding } from "@/lib/connectors/adapters/_shared/a2ui-mapper"
import { getIssueRunRegistry, resetIssueRunRegistry } from "@/lib/issues/run/registry"
import { createIssueRun } from "@/lib/db/issue-runs"
import {
  actorFromUser,
  deleteSiblingBindings,
  handleIssueActionCallback,
  readIssueActionPayload,
  rememberIssueProject,
  type IssueActionHandlerDeps,
} from "./callback-handler"
import type { IssueImPushDeps } from "./push"

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(dbFixture.restore)
afterAll(dbFixture.dispose)
afterEach(() => {
  resetIssueRunRegistry()
  mockFindSession.mockReset()
  mockFindSession.mockResolvedValue(undefined)
})

const CONV = "lark:lark-1:oc_1"

function binding(
  payload: Record<string, unknown>,
  over: Partial<ConnectorCallbackBindingRow> = {}
) {
  return {
    id: "lark-1:a2ui:s1:btn",
    adapterId: "lark-1",
    actionId: "a2ui:s1:btn",
    kind: "issue_action",
    surfaceId: "s1",
    conversationKey: CONV,
    createdAt: 1,
    payload,
    ...over,
  } as ConnectorCallbackBindingRow
}

function harness(over: Partial<IssueActionHandlerDeps> = {}) {
  const sent: Array<{ text?: string; card?: boolean }> = []
  const audits: Array<Record<string, unknown>> = []
  const push: Partial<IssueImPushDeps> = {
    enqueue: async (input) => {
      const seg = input.request.segments[0] as { type: string; text?: string }
      sent.push(seg.type === "text" ? { text: seg.text } : { card: true })
    },
    buildSegment: (surfaceId, content) => ({ type: "a2ui", surfaceId, content }),
    audit: async () => {},
    isPiiSafe: () => true,
    now: () => 5,
  }
  const deps: Partial<IssueActionHandlerDeps> = {
    push,
    audit: async (entry) => {
      audits.push(entry as never)
    },
    now: () => 5,
    resolveWorkspaceId: async () => "w1",
    ...over,
  }
  return { deps, sent, audits }
}

async function seed(status: "todo" | "in_review" | "in_progress" = "todo") {
  const project = await createIssueProject({ projectId: "w1", name: "M", key: "MERC" })
  const issue = await createIssue({
    projectId: "w1",
    issueProjectId: project.id,
    title: "t",
    createdBy: { kind: "human" },
    status,
    assignee: { kind: "agent", id: "c1" },
  })
  return { project, issue }
}

describe("readIssueActionPayload / actorFromUser", () => {
  it("validates every action shape and rejects garbage", () => {
    expect(readIssueActionPayload(undefined)).toBeNull()
    expect(readIssueActionPayload({ action: "nope" })).toBeNull()
    expect(readIssueActionPayload({ action: "move", issueId: "i", to: "bogus" })).toBeNull()
    expect(readIssueActionPayload({ action: "move", issueId: "i", to: "done" })).toEqual({
      action: "move",
      issueId: "i",
      to: "done",
    })
    expect(readIssueActionPayload({ action: "run" })).toBeNull()
    expect(readIssueActionPayload({ action: "run", issueId: "i" })).toEqual({
      action: "run",
      issueId: "i",
    })
    expect(
      readIssueActionPayload({ action: "create", issueProjectId: "p", draft: { title: "" } })
    ).toBeNull()
    expect(
      readIssueActionPayload({
        action: "create",
        issueProjectId: "p",
        draft: { draftId: "d", title: "T", description: "", sourceMessageId: "m" },
      })
    ).toEqual({
      action: "create",
      issueProjectId: "p",
      draft: { draftId: "d", title: "T", sourceMessageId: "m" },
    })
    expect(readIssueActionPayload({ action: "cancel_create" })).toBeNull()
    expect(readIssueActionPayload({ action: "cancel_create", draftId: "d" })).toEqual({
      action: "cancel_create",
      draftId: "d",
    })
    expect(actorFromUser(undefined)).toEqual({ kind: "human" })
    expect(actorFromUser({ remoteUserId: "u1", displayName: "Zoe" })).toEqual({
      kind: "human",
      id: "u1",
      label: "Zoe",
    })
  })
})

describe("handleIssueActionCallback", () => {
  it("ignores malformed bindings and cleans the card up", async () => {
    await recordCallbackBinding({
      adapterId: "lark-1",
      actionId: "x",
      surfaceId: "s1",
      kind: "issue_action",
    })
    const { deps } = harness()
    const out = await handleIssueActionCallback(
      { binding: binding({ action: "nope" }), adapterId: "lark-1" },
      deps
    )
    expect(out).toEqual({ kind: "ignored", reason: "malformed-payload" })
    expect(await getDb().connectorCallbackBindings.count()).toBe(0)
    const noConv = await handleIssueActionCallback(
      {
        binding: binding({ action: "run", issueId: "i" }, { conversationKey: undefined }),
        adapterId: "lark-1",
      },
      deps
    )
    expect(noConv).toEqual({ kind: "ignored", reason: "no-conversation" })
  })

  it("moves through the guard, replies with a refreshed card, and replies denials", async () => {
    const { issue } = await seed("in_review")
    const { deps, sent, audits } = harness()
    const out = await handleIssueActionCallback(
      {
        binding: binding({ action: "move", issueId: issue.id, to: "done" }),
        adapterId: "lark-1",
        user: { remoteUserId: "u1", displayName: "Zoe" },
      },
      deps
    )
    expect(out.kind).toBe("moved")
    expect((await getIssue(issue.id))!.status).toBe("done")
    expect(sent).toEqual([{ card: true }])
    expect(audits[0]).toMatchObject({
      kind: "issue.card_action",
      fields: { action: "move", to: "done" },
    })

    // Runtime-owned: an active run refuses a move into in_progress.
    const other = await createIssue({
      projectId: "w1",
      issueProjectId: issue.issueProjectId,
      title: "u",
      createdBy: { kind: "human" },
      status: "in_progress",
    })
    await createIssueRun({
      issueId: other.id,
      projectId: "w1",
      adapterId: "x",
      kind: "agent-task",
      targetId: "t",
      by: { kind: "human" },
    })
    const denied = await handleIssueActionCallback(
      { binding: binding({ action: "move", issueId: other.id, to: "todo" }), adapterId: "lark-1" },
      deps
    )
    expect(denied).toEqual({ kind: "move_denied", reason: "runtime-owned" })
    expect(sent.at(-1)).toEqual({ text: "✗ Cannot move to todo: runtime-owned" })
    expect(audits.at(-1)).toMatchObject({
      kind: "issue.card_action_denied",
      reason: "runtime-owned",
    })
  })

  it("runs on the first engine that can, with the im origin, or replies the refusal", async () => {
    const { issue } = await seed("todo")
    const starts: unknown[] = []
    getIssueRunRegistry().register({
      id: "fake",
      kind: "agent-task",
      canRun: async () => ({ ok: true }),
      start: async (target, ctx) => {
        starts.push(ctx)
        return createIssueRun({
          issueId: target.issue.id,
          projectId: "w1",
          adapterId: "fake",
          kind: "agent-task",
          targetId: "t",
          by: ctx.by,
        })
      },
      poll: async () => null,
    })
    const { deps, sent } = harness()
    const out = await handleIssueActionCallback(
      {
        binding: binding({ action: "run", issueId: issue.id }),
        adapterId: "lark-1",
        user: { remoteUserId: "u1" },
      },
      deps
    )
    expect(out).toMatchObject({ kind: "run_started", adapterId: "fake" })
    expect(starts[0]).toMatchObject({ origin: "im", by: { kind: "human", id: "u1" } })
    expect((await getIssue(issue.id))!.status).toBe("in_progress")
    expect(sent).toEqual([{ text: "▶ MERC-1 dispatched to fake" }, { card: true }])

    // Now a second click: the run is active → tracker refuses.
    const refused = await handleIssueActionCallback(
      { binding: binding({ action: "run", issueId: issue.id }), adapterId: "lark-1" },
      deps
    )
    expect(refused).toEqual({ kind: "run_refused", reason: "run-active" })
    expect(sent.at(-1)).toEqual({ text: "✗ Cannot run: run-active" })
  })

  it("replies adapter-missing when nothing is registered and surfaces refusals from start", async () => {
    const { issue } = await seed("todo")
    const { deps, sent } = harness()
    expect(
      await handleIssueActionCallback(
        { binding: binding({ action: "run", issueId: issue.id }), adapterId: "lark-1" },
        deps
      )
    ).toEqual({ kind: "run_refused", reason: "adapter-missing" })
    expect(sent.at(-1)).toEqual({ text: "✗ Cannot run: adapter-missing" })

    // canRun says yes but start-time verdict changed → IssueRunRefusedError path.
    let calls = 0
    getIssueRunRegistry().register({
      id: "flaky",
      kind: "agent-task",
      canRun: async () => (calls++ === 0 ? { ok: true } : { ok: false, reason: "team-busy" }),
      start: async () => {
        throw new Error("unreachable")
      },
      poll: async () => null,
    })
    expect(
      await handleIssueActionCallback(
        { binding: binding({ action: "run", issueId: issue.id }), adapterId: "lark-1" },
        deps
      )
    ).toEqual({ kind: "run_refused", reason: "team-busy" })

    // Engine failures propagate for the bus to audit.
    getIssueRunRegistry().register({
      id: "boom",
      kind: "agent-task",
      canRun: async () => ({ ok: true }),
      start: async () => {
        throw new Error("engine down")
      },
      poll: async () => null,
    })
    getIssueRunRegistry().unregister("flaky")
    await expect(
      handleIssueActionCallback(
        { binding: binding({ action: "run", issueId: issue.id }), adapterId: "lark-1" },
        deps
      )
    ).rejects.toThrow("engine down")
  })

  it("creates the issue with an IM origin, remembers the project, consumes the card, replies a card", async () => {
    const { project } = await seed()
    await recordCallbackBinding({
      adapterId: "lark-1",
      actionId: "a2ui:s1:p1",
      surfaceId: "s1",
      kind: "issue_action",
    })
    await recordCallbackBinding({
      adapterId: "lark-1",
      actionId: "a2ui:s1:cancel",
      surfaceId: "s1",
      kind: "issue_action",
    })
    await recordCallbackBinding({
      adapterId: "lark-1",
      actionId: "a2ui:other",
      surfaceId: "s-other",
      kind: "issue_action",
    })
    // The conversation already has an override row (as it would after any
    // in-chat command); the remembered project lands on it.
    await patchConversationOverride(CONV, {}, "sess-1")
    const { deps, sent } = harness()
    const out = await handleIssueActionCallback(
      {
        binding: binding({
          action: "create",
          issueProjectId: project.id,
          draft: { draftId: "d1", title: "From chat", description: "body", sourceMessageId: "m9" },
        }),
        adapterId: "lark-1",
        user: { remoteUserId: "u1", displayName: "Zoe" },
      },
      deps
    )
    expect(out.kind).toBe("created")
    const created = out.kind === "created" ? out.issue : null
    expect(created).toMatchObject({
      title: "From chat",
      description: "body",
      issueProjectId: project.id,
      createdBy: { kind: "human", id: "u1", label: "Zoe" },
      origin: { kind: "im", conversationKey: CONV, messageId: "m9" },
    })
    expect((await readForResolution(CONV))?.issueProjectId).toBe(project.id)
    const remaining = await getDb().connectorCallbackBindings.toArray()
    expect(remaining.map((r) => r.surfaceId)).toEqual(["s-other"])
    expect(sent).toEqual([{ card: true }])
  })

  it("still creates when the conversation cannot be remembered (no row, no session)", async () => {
    const { project } = await seed()
    const { deps, sent } = harness()
    const out = await handleIssueActionCallback(
      {
        binding: binding({
          action: "create",
          issueProjectId: project.id,
          draft: { draftId: "d2", title: "Unremembered" },
        }),
        adapterId: "lark-1",
      },
      deps
    )
    expect(out.kind).toBe("created")
    expect(await readForResolution(CONV)).toBeUndefined()
    expect(sent).toEqual([{ card: true }])
  })

  it("rememberIssueProject mints the row from the bound session when there is none", async () => {
    mockFindSession.mockResolvedValueOnce({ id: "sess-9" })
    expect(await rememberIssueProject(CONV, "p-9")).toBe(true)
    expect((await readForResolution(CONV))?.issueProjectId).toBe("p-9")
    mockFindSession.mockRejectedValueOnce(new Error("db down"))
    expect(await rememberIssueProject("lark:lark-1:oc_2", "p")).toBe(false)
  })

  it("refuses to create without a workspace and cancels cleanly", async () => {
    const { deps: noWs } = harness({ resolveWorkspaceId: async () => null })
    expect(
      await handleIssueActionCallback(
        {
          binding: binding({
            action: "create",
            issueProjectId: "p",
            draft: { draftId: "d", title: "x" },
          }),
          adapterId: "lark-1",
        },
        noWs
      )
    ).toEqual({ kind: "ignored", reason: "no-workspace" })

    await recordCallbackBinding({
      adapterId: "lark-1",
      actionId: "a2ui:s1:p1",
      surfaceId: "s1",
      kind: "issue_action",
    })
    const { deps, sent } = harness()
    expect(
      await handleIssueActionCallback(
        { binding: binding({ action: "cancel_create", draftId: "d1" }), adapterId: "lark-1" },
        deps
      )
    ).toEqual({ kind: "create_cancelled" })
    expect(await getDb().connectorCallbackBindings.count()).toBe(0)
    expect(sent).toEqual([{ text: "⊘ Not filed." }])
    await deleteSiblingBindings("lark-1", "nothing")
  })
})
