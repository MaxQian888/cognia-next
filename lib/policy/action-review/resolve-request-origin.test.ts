/** @jest-environment jsdom */

import { automatedTurnMetadata } from "@cognia/agent-config-types/automated-turn"
import type { StoredMessage } from "@cognia/agent-config-types"

import {
  __clearAllSubagentApprovalRoutesForTesting,
  registerSubagentApprovalRoute,
} from "@/lib/claude/agents/subagent-approval-routes"
import { subSessionId } from "@/lib/claude/team-session-id"
import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"

import { conversationTarget } from "./outbound-targets"
import {
  __clearRequestOriginCacheForTesting,
  resolveSessionRequestOrigin,
} from "./resolve-request-origin"

const mockSharedRequester = jest.fn<string | undefined, [string]>()
jest.mock("@/lib/collab/shared-run-coordinator", () => ({
  getSharedRunRequester: (id: string) => mockSharedRequester(id),
}))

const GROUP = "lark:bot-a:oc_1"
let clock = 1_000

async function session(id: string, extra: Record<string, unknown> = {}) {
  await getDb().sessions.put({ id, title: id, createdAt: 1, updatedAt: 1, ...extra } as never)
}

async function message(
  sessionId: string,
  id: string,
  role: StoredMessage["role"],
  extra: Partial<StoredMessage> = {}
) {
  clock += 1
  await getDb().messages.put({
    id,
    sessionId,
    role,
    parts: [{ type: "text", text: id }],
    createdAt: clock,
    ...extra,
  } as StoredMessage)
}

function imMessage(sessionId: string, id: string, remoteUserId: string) {
  return message(sessionId, id, "user", {
    metadata: {
      platformMessage: {
        messageId: id,
        platform: "lark",
        sender: { id: `pi-${remoteUserId}`, remoteUserId, platform: "lark", adapterId: "bot-a" },
      },
    },
  })
}

async function runningJob(remoteUserId: string, conversationKey: string) {
  await getDb().connectorInboundJobs.put({
    id: `job-${remoteUserId}`,
    conversationKey,
    status: "running",
    receivedAt: clock,
    event: {
      sender: { id: `pi-${remoteUserId}`, remoteUserId, platform: "lark", adapterId: "bot-a" },
    },
  } as never)
}

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
afterAll(dbFixture.dispose)

beforeEach(async () => {
  await dbFixture.restore()
  __clearRequestOriginCacheForTesting()
  __clearAllSubagentApprovalRoutesForTesting()
  mockSharedRequester.mockReset()
})

describe("resolveSessionRequestOrigin", () => {
  it("uses the local person's newest instruction and skips automation rows", async () => {
    await session("chat")
    await message("chat", "u1", "user")
    await message("chat", "a1", "assistant")
    await message("chat", "bg", "user", { metadata: automatedTurnMetadata("background-result") })
    await message("chat", "peer", "user", {
      metadata: { sessionPeerMessage: { origin: "agent", messageId: "p" } },
    })
    const origin = await resolveSessionRequestOrigin("chat")
    expect(origin).toEqual({
      rootSessionId: "chat",
      requester: { kind: "local" },
      instructionEpoch: "msg:u1",
    })

    await message("chat", "u2", "user")
    expect((await resolveSessionRequestOrigin("chat")).instructionEpoch).toBe("msg:u2")
  })

  it("resolves a nested subagent and a team member to the root's epoch", async () => {
    await session("chat")
    await message("chat", "u1", "user")
    registerSubagentApprovalRoute("eph", {
      parentSessionId: "chat",
      runId: "r",
      subagentId: "coder",
      backgrounded: false,
    })
    expect(await resolveSessionRequestOrigin("eph")).toMatchObject({
      rootSessionId: "chat",
      instructionEpoch: "msg:u1",
    })

    await session("team")
    await message("team", "t1", "user")
    expect(
      await resolveSessionRequestOrigin(subSessionId("team", "char-a", "turn-1"))
    ).toMatchObject({ rootSessionId: "team", instructionEpoch: "msg:t1" })
  })

  it("takes an IM requester from the running job, and other members do not advance it", async () => {
    await session("im", {
      platformBinding: {
        adapterId: "bot-a",
        conversationKey: `${GROUP}:om_thread`,
        platform: "lark",
        conversationRef: {},
      },
    })
    await imMessage("im", "alice-1", "alice")
    await imMessage("im", "bob-1", "bob")
    await runningJob("alice", `${GROUP}:om_thread`)

    const origin = await resolveSessionRequestOrigin("im")
    expect(origin.requester).toEqual({
      kind: "im",
      remoteUserId: "alice",
      platformIdentityId: "pi-alice",
    })
    expect(origin.instructionEpoch).toBe("msg:alice-1")
    expect(origin.originThread).toEqual(conversationTarget(GROUP))
  })

  it("treats an IM-bound session with no running job as the local person's", async () => {
    await session("im", {
      platformBinding: { adapterId: "bot-a", conversationKey: GROUP, platform: "lark" },
    })
    await imMessage("im", "alice-1", "alice")
    await message("im", "local-1", "user")
    expect(await resolveSessionRequestOrigin("im")).toMatchObject({
      requester: { kind: "local" },
      instructionEpoch: "msg:local-1",
      originThread: conversationTarget(GROUP),
    })
  })

  it("scopes a shared session's epoch to the member its run serves", async () => {
    await session("shared", { collaboration: { orgId: "o", sessionId: "remote" } })
    await message("shared", "m1", "user", {
      collaboration: { author: { kind: "human", id: "user-1" } } as never,
    })
    await message("shared", "m2", "user", {
      collaboration: { author: { kind: "human", id: "user-2" } } as never,
    })
    mockSharedRequester.mockReturnValue("user-1")
    expect(await resolveSessionRequestOrigin("shared")).toMatchObject({
      requester: { kind: "member", userId: "user-1" },
      instructionEpoch: "msg:m1",
    })
  })

  it("names an epoch of its own when the requester has said nothing there", async () => {
    await session("fresh")
    await message("fresh", "seed", "user", { metadata: automatedTurnMetadata("plugin") })
    expect((await resolveSessionRequestOrigin("fresh")).instructionEpoch).toBe("none:fresh")
    expect((await resolveSessionRequestOrigin("missing")).instructionEpoch).toBe("none:missing")
  })

  it("reads the session once while no new message arrives", async () => {
    const findLatestInstruction = jest.fn(async () => "u1")
    const deps = {
      getSession: async () => undefined,
      latestMessageId: async () => "newest",
      findLatestInstruction,
    }
    await resolveSessionRequestOrigin("chat", deps)
    await resolveSessionRequestOrigin("chat", deps)
    expect(findLatestInstruction).toHaveBeenCalledTimes(1)
    await resolveSessionRequestOrigin("chat", { ...deps, latestMessageId: async () => "newer" })
    expect(findLatestInstruction).toHaveBeenCalledTimes(2)
  })
})
