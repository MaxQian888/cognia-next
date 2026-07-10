jest.mock("./_helpers", () => ({
  ...jest.requireActual("./_helpers"),
  resolveChatCapableAdapter: jest.fn(),
  withScopeCapture: jest.fn((_id: string, fn: () => Promise<unknown>) => fn()),
}))

jest.mock("@/lib/connectors/conversation-bootstrap", () => ({
  bootstrapConversation: jest.fn(),
}))

jest.mock("@/lib/connectors/session-bindings", () => ({
  findSessionByConversationKey: jest.fn(),
}))

jest.mock("@/lib/db/conversation-overrides", () => ({
  upsertByConversationKey: jest.fn().mockResolvedValue({ id: "cov_1" }),
}))

jest.mock("@/lib/db/outbound-jobs", () => ({
  enqueueOutbound: jest.fn().mockResolvedValue({ id: "job1" }),
}))

jest.mock("@/lib/twin/ingest/redact", () => ({
  hasNoLeakingPiiDeep: jest.fn(() => true),
}))

jest.mock("@/lib/connectors/team-dispatch", () => ({
  startTeamRunFromIM: jest.fn().mockResolvedValue({ started: true }),
}))

jest.mock("@/lib/connectors/audit", () => ({
  appendAudit: jest.fn().mockResolvedValue(undefined),
}))

import { z } from "zod"

import { getSharedBuiltInSkillRegistry } from "../registry"
import "./dispatch-task"
import { resolveChatCapableAdapter } from "./_helpers"
import { bootstrapConversation } from "@/lib/connectors/conversation-bootstrap"
import { findSessionByConversationKey } from "@/lib/connectors/session-bindings"
import { upsertByConversationKey } from "@/lib/db/conversation-overrides"
import { enqueueOutbound } from "@/lib/db/outbound-jobs"
import { hasNoLeakingPiiDeep } from "@/lib/twin/ingest/redact"
import { startTeamRunFromIM } from "@/lib/connectors/team-dispatch"
import { appendAudit } from "@/lib/connectors/audit"

const mResolve = resolveChatCapableAdapter as jest.Mock
const mBootstrap = bootstrapConversation as jest.Mock
const mFindSession = findSessionByConversationKey as jest.Mock
const mUpsert = upsertByConversationKey as jest.Mock
const mEnqueue = enqueueOutbound as jest.Mock
const mPii = hasNoLeakingPiiDeep as jest.Mock
const mStartRun = startTeamRunFromIM as jest.Mock
const mAudit = appendAudit as jest.Mock

const mCreateChat = jest.fn()

function skill() {
  const s = getSharedBuiltInSkillRegistry()
    .list()
    .find((x) => x.id === "im.dispatch_task")
  if (!s) throw new Error("im.dispatch_task not registered")
  return s
}

beforeEach(() => {
  jest.clearAllMocks()
  mPii.mockReturnValue(true)
  mResolve.mockResolvedValue({
    adapterId: "a1",
    platform: "lark",
    adapter: { createChat: mCreateChat },
  })
  mCreateChat.mockResolvedValue({ chatId: "oc_new" })
  mBootstrap.mockResolvedValue({
    conversationKey: "lark:a1:oc_new",
    sessionId: "s_new",
    created: true,
  })
  mFindSession.mockResolvedValue(undefined)
  mStartRun.mockResolvedValue({ started: true })
})

describe("im.dispatch_task execute — create-new path", () => {
  it("creates the chat, bootstraps, binds the team (clearing teamDisabled), posts the brief, and starts the run", async () => {
    const out = await skill().execute(
      {
        title: "Ship W4",
        brief: "Implement the dispatch skill",
        respondWithTeamId: "team_1",
        memberIds: ["ou_a", "ou_b"],
      },
      { sessionId: "s" }
    )

    expect(mCreateChat).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Ship W4", memberIds: ["ou_a", "ou_b"] })
    )
    expect(mCreateChat.mock.calls[0][0].idempotencyKey).toEqual(expect.any(String))
    expect(mBootstrap).toHaveBeenCalledWith({
      platform: "lark",
      adapterId: "a1",
      remoteChatId: "oc_new",
      name: "Ship W4",
      source: "im.dispatch_task",
    })

    // Team binding clears an earlier `teamDisabled` veto (explicit undefined
    // key so the upsert merge overwrites it), never touches characterId.
    expect(mUpsert).toHaveBeenCalledWith({
      conversationKey: "lark:a1:oc_new",
      sessionId: "s_new",
      teamId: "team_1",
      teamDisabled: undefined,
    })

    expect(mEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        adapterId: "a1",
        conversationKey: "lark:a1:oc_new",
        source: "skill",
      })
    )
    const request = mEnqueue.mock.calls[0][0].request
    expect(request.segments).toEqual([
      { type: "text", text: "【Ship W4】\nImplement the dispatch skill" },
    ])
    expect(request.metadata.idempotencyKey).toEqual(expect.any(String))

    expect(mStartRun).toHaveBeenCalledWith({
      teamId: "team_1",
      goal: "Implement the dispatch skill",
      adapterId: "a1",
      conversationKey: "lark:a1:oc_new",
      sessionId: "s_new",
    })

    expect(mAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        adapterId: "a1",
        kind: "task.dispatched",
        conversationKey: "lark:a1:oc_new",
        fields: expect.objectContaining({
          conversationKey: "lark:a1:oc_new",
          teamId: "team_1",
          created: true,
          runStarted: true,
        }),
      })
    )

    expect(out).toEqual({
      conversationKey: "lark:a1:oc_new",
      sessionId: "s_new",
      chatId: "oc_new",
      created: true,
      bound: { teamId: "team_1" },
      brief: "sent",
      run: "started",
    })
  })

  it("surfaces invalidMemberIds from createChat as a partial outcome", async () => {
    mCreateChat.mockResolvedValue({ chatId: "oc_new", invalidMemberIds: ["ou_bad"] })
    const out = (await skill().execute(
      { title: "T", brief: "B", respondWithTeamId: "team_1", memberIds: ["ou_a", "ou_bad"] },
      { sessionId: "s" }
    )) as { invalidMemberIds?: string[] }
    expect(out.invalidMemberIds).toEqual(["ou_bad"])
  })

  it("reports the run failure reason when the team run does not start", async () => {
    mStartRun.mockResolvedValue({ started: false, reason: "team_not_found" })
    const out = (await skill().execute(
      { title: "T", brief: "B", respondWithTeamId: "team_missing" },
      { sessionId: "s" }
    )) as { run?: string }
    expect(out.run).toBe("team_not_found")
    expect(mAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "task.dispatched",
        fields: expect.objectContaining({ runStarted: false }),
      })
    )
  })

  it("threads the explicit adapterId into adapter resolution", async () => {
    await skill().execute(
      { title: "T", brief: "B", respondWithTeamId: "team_1", adapterId: "a-other" },
      { sessionId: "s" }
    )
    expect(mResolve).toHaveBeenCalledWith(expect.anything(), ["chat.create"], "a-other")
  })
})

describe("im.dispatch_task execute — existing-conversation path", () => {
  it("resolves the bound session, binds a character WITHOUT touching teamDisabled, and never auto-runs", async () => {
    mFindSession.mockResolvedValue({
      id: "s_ex",
      platformBinding: {
        conversationRef: { platform: "lark", adapterId: "a2", channelId: "oc_ex" },
      },
    })
    const out = await skill().execute(
      {
        title: "Follow up",
        brief: "Check the numbers",
        respondWithCharacterId: "char_1",
        existingConversationKey: "lark:a2:oc_ex",
      },
      { sessionId: "s" }
    )

    expect(mCreateChat).not.toHaveBeenCalled()
    expect(mResolve).not.toHaveBeenCalled()
    expect(mBootstrap).not.toHaveBeenCalled()

    expect(mUpsert).toHaveBeenCalledWith({
      conversationKey: "lark:a2:oc_ex",
      sessionId: "s_ex",
      characterId: "char_1",
    })
    // Character binding must NOT clear/overwrite the teamDisabled veto.
    expect(mUpsert.mock.calls[0][0]).not.toHaveProperty("teamDisabled")
    expect(mUpsert.mock.calls[0][0]).not.toHaveProperty("teamId")

    expect(mEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({ adapterId: "a2", conversationKey: "lark:a2:oc_ex" })
    )
    expect(mEnqueue.mock.calls[0][0].request.conversationRef).toEqual({
      platform: "lark",
      adapterId: "a2",
      channelId: "oc_ex",
    })

    // Characters respond to the next inbound — nothing to "start".
    expect(mStartRun).not.toHaveBeenCalled()

    expect(out).toEqual({
      conversationKey: "lark:a2:oc_ex",
      sessionId: "s_ex",
      created: false,
      bound: { characterId: "char_1" },
      brief: "sent",
    })
  })

  it("throws an actionable error for an unknown existingConversationKey", async () => {
    mFindSession.mockResolvedValue(undefined)
    await expect(
      skill().execute(
        {
          title: "T",
          brief: "B",
          respondWithTeamId: "team_1",
          existingConversationKey: "lark:a2:oc_ghost",
        },
        { sessionId: "s" }
      )
    ).rejects.toThrow(/Unknown conversation lark:a2:oc_ghost/)
    expect(mUpsert).not.toHaveBeenCalled()
    expect(mEnqueue).not.toHaveBeenCalled()
  })
})

describe("im.dispatch_task execute — startRun / PII gates", () => {
  it("startRun:false binds the team but skips the auto-run", async () => {
    const out = (await skill().execute(
      { title: "T", brief: "B", respondWithTeamId: "team_1", startRun: false },
      { sessionId: "s" }
    )) as { run?: string }
    expect(mStartRun).not.toHaveBeenCalled()
    expect(out.run).toBeUndefined()
    expect(mAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "task.dispatched",
        fields: expect.not.objectContaining({ runStarted: expect.anything() }),
      })
    )
  })

  it("blocks a PII-leaking brief: chat still created + bound, no enqueue, no run, partial result + audit", async () => {
    mPii.mockReturnValue(false)
    const out = (await skill().execute(
      { title: "T", brief: "mail alice@corp.com", respondWithTeamId: "team_1" },
      { sessionId: "s" }
    )) as { brief?: string; run?: string; created?: boolean }

    expect(mCreateChat).toHaveBeenCalled()
    expect(mUpsert).toHaveBeenCalled()
    expect(mEnqueue).not.toHaveBeenCalled()
    // The brief doubles as the team goal — a blocked brief must not reach the
    // model through the run either.
    expect(mStartRun).not.toHaveBeenCalled()

    expect(out.created).toBe(true)
    expect(out.brief).toBe("pii_blocked")
    expect(out.run).toBe("pii_blocked")
    expect(mAudit).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "adapter.error", reason: "pii_blocked" })
    )
    expect(mAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "task.dispatched",
        fields: expect.objectContaining({ created: true, runStarted: false }),
      })
    )
  })
})

describe("im.dispatch_task schema — responder refine", () => {
  const base = { title: "T", brief: "B" }

  it("rejects when NEITHER responder field is provided", () => {
    expect(skill().inputSchema.safeParse(base).success).toBe(false)
  })

  it("rejects when BOTH responder fields are provided", () => {
    expect(
      skill().inputSchema.safeParse({
        ...base,
        respondWithTeamId: "team_1",
        respondWithCharacterId: "char_1",
      }).success
    ).toBe(false)
  })

  it("accepts exactly one responder field", () => {
    expect(skill().inputSchema.safeParse({ ...base, respondWithTeamId: "team_1" }).success).toBe(
      true
    )
    expect(
      skill().inputSchema.safeParse({ ...base, respondWithCharacterId: "char_1" }).success
    ).toBe(true)
  })

  it("stays representable as a JSON Schema for the MCP manifest despite the refine", () => {
    expect(() => z.toJSONSchema(skill().inputSchema)).not.toThrow()
  })
})
