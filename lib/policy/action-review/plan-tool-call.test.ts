/** @jest-environment jsdom */

import { getDb } from "@/lib/db/schema"
import { createDbTestFixture } from "@/lib/db/test-fixture"
import { listActionReviewReceipts } from "@/lib/db/action-review-receipts"

import {
  __resetChatToolReviewsForTesting,
  openChatToolReview,
  recordChatToolApprovalDecision,
  settleChatToolReview,
} from "./chat-tool-channel"
import {
  __resetAuthorizedToolCallsForTesting,
  authorizedOutboundToolCall,
} from "./authorized-tool-calls"
import { conversationTarget, outboundFingerprint } from "./outbound-targets"
import { taskPlanOrigin } from "./plan-context"
import {
  answerWithOutboundPolicy,
  humanOutboundGrant,
  outboundFenceMessage,
  outboundToolDecision,
  planOutboundAsk,
  planOutboundToolCall,
  recordOutboundShadowObservation,
  type OutboundToolPlannerOptions,
} from "./plan-tool-call"
import { __clearRequestOriginCacheForTesting } from "./resolve-request-origin"

jest.mock("@/lib/collab/shared-run-coordinator", () => ({
  getSharedRunRequester: () => undefined,
}))

const THREAD_KEY = "lark:bot-a:oc_thread"
const OTHER_KEY = "lark:bot-a:oc_other"
const ENFORCE = { agentPermissions: { outboundAuthorization: "enforce" } }

function options(extra: Partial<OutboundToolPlannerOptions> = {}): OutboundToolPlannerOptions {
  return {
    unattended: false,
    settings: () => ENFORCE,
    origin: {
      rootSessionId: "chat",
      instructionEpoch: "msg:u1",
      originThread: conversationTarget(THREAD_KEY)!,
    },
    ...extra,
  }
}

function send(conversationKey: string, requestId = "r1") {
  return {
    sessionId: "chat",
    requestId,
    toolName: "mcp__cognia-plugin-tools__connectors_send_message",
    input: { conversationKey, text: "hello" },
  }
}

async function receipts() {
  return listActionReviewReceipts({})
}

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
afterAll(dbFixture.dispose)
beforeEach(async () => {
  await dbFixture.restore()
  __resetChatToolReviewsForTesting()
  __clearRequestOriginCacheForTesting()
  __resetAuthorizedToolCallsForTesting()
})

describe("planOutboundToolCall", () => {
  it("leaves a tool that is not outbound alone", async () => {
    await expect(
      planOutboundToolCall({ ...send(OTHER_KEY), toolName: "mcp__cognia-tools__write" }, options())
    ).resolves.toBeNull()
  })

  it("allows a reply into the origin thread without asking", async () => {
    const plan = await planOutboundToolCall(send(`${THREAD_KEY}:om_reply`), options())
    expect(plan && outboundToolDecision(plan, "send")).toEqual({
      kind: "allow",
      attribution: { authority: "policy-default" },
    })
  })

  it("asks for another group, and records the plan on the call's receipt", async () => {
    await openChatToolReview({ sessionId: "chat", requestId: "r1", toolName: "send" })
    const plan = await planOutboundToolCall(send(OTHER_KEY), options())
    expect(plan && outboundToolDecision(plan, "send")).toEqual({ kind: "ask" })
    await settleChatToolReview({
      sessionId: "chat",
      requestId: "r1",
      outcome: "allow",
      authority: "human",
      grant: { scope: "once" },
    })
    const [row] = await receipts()
    expect(row.request.subject.targets).toEqual([
      {
        channel: "bot-a",
        fingerprint: outboundFingerprint(conversationTarget(OTHER_KEY)!),
      },
    ])
    expect(row.request.origin).toMatchObject({ rootSessionId: "chat", instructionEpoch: "msg:u1" })
    expect(row.request.plan).toEqual({ outcome: "ask", enforced: true })
    expect(row.decision.grant).toEqual({ scope: "once" })
  })

  it("only records in shadow mode", async () => {
    const plan = await planOutboundToolCall(send(OTHER_KEY), options({ settings: () => ({}) }))
    expect(plan?.result.plan).toEqual({ outcome: "ask", enforced: false })
    expect(plan && outboundToolDecision(plan, "send")).toEqual({ kind: "unchanged" })
  })
})

describe("the fence and the instruction grant, end to end", () => {
  it("denies the same recipient after a person's Deny, until a new instruction", async () => {
    await openChatToolReview({ sessionId: "chat", requestId: "r1", toolName: "send" })
    await planOutboundToolCall(send(OTHER_KEY, "r1"), options())
    await recordChatToolApprovalDecision({ sessionId: "chat", requestId: "r1" }, "deny")

    const again = await planOutboundToolCall(send(OTHER_KEY, "r2"), options())
    expect(again && outboundToolDecision(again, "send")).toEqual({
      kind: "deny",
      message: outboundFenceMessage("send"),
      attribution: { authority: "policy-deny" },
    })

    const nextInstruction = await planOutboundToolCall(
      send(OTHER_KEY, "r3"),
      options({ origin: { rootSessionId: "chat", instructionEpoch: "msg:u2" } })
    )
    expect(nextInstruction?.result.plan.outcome).toBe("ask")
  })

  it("does not fence on a timeout", async () => {
    await openChatToolReview({ sessionId: "chat", requestId: "r1", toolName: "send" })
    await planOutboundToolCall(send(OTHER_KEY, "r1"), options())
    await settleChatToolReview({
      sessionId: "chat",
      requestId: "r1",
      outcome: "deny",
      authority: "timeout",
    })
    const again = await planOutboundToolCall(send(OTHER_KEY, "r2"), options())
    expect(again?.result.plan.outcome).toBe("ask")
  })

  it("allows a recipient a person allowed for the request, for the rest of it", async () => {
    await openChatToolReview({ sessionId: "chat", requestId: "r1", toolName: "send" })
    const first = await planOutboundToolCall(send(OTHER_KEY, "r1"), options())
    await recordChatToolApprovalDecision(
      { sessionId: "chat", requestId: "r1" },
      "allow",
      humanOutboundGrant(true, { targets: first!.targets })
    )
    const again = await planOutboundToolCall(send(OTHER_KEY, "r2"), options())
    expect(again && outboundToolDecision(again, "send")).toEqual({
      kind: "allow",
      attribution: { authority: "human", grant: { scope: "instruction" } },
    })
  })

  it("reads the requester's epoch from the session when no origin is given", async () => {
    await getDb().sessions.put({ id: "chat", title: "c", createdAt: 1, updatedAt: 1 } as never)
    await getDb().messages.put({
      id: "u1",
      sessionId: "chat",
      role: "user",
      parts: [{ type: "text", text: "draft it, don't send" }],
      createdAt: 10,
    } as never)
    const plan = await planOutboundToolCall(send(OTHER_KEY), options({ origin: undefined }))
    expect(plan).toMatchObject({ rootSessionId: "chat", instructionEpoch: "msg:u1" })
  })

  it("plans a scheduled task's delivery to its /schedule conversation as the origin thread", async () => {
    const task = {
      id: "t1",
      payload: {
        scheduleProvenance: {
          source: "im",
          adapterId: "bot-a",
          conversationKey: THREAD_KEY,
          senderId: "u-alice",
        },
      } as never,
    }
    const plan = await planOutboundToolCall(
      send(THREAD_KEY),
      options({ unattended: true, origin: async () => taskPlanOrigin(task) })
    )
    expect(plan).toMatchObject({ rootSessionId: "task:t1", instructionEpoch: "task:t1@0" })
    expect(plan?.result.plan.outcome).toBe("allow")
  })
})

describe("humanOutboundGrant", () => {
  it("grants for the request only when every recipient can be named", () => {
    const named = { targets: [conversationTarget(OTHER_KEY)!] }
    expect(humanOutboundGrant(true, named)).toEqual({ scope: "instruction" })
    expect(humanOutboundGrant(false, named)).toEqual({ scope: "once" })
    expect(
      humanOutboundGrant(true, {
        targets: [{ kind: "public", channel: "tool:deploy_site", recipient: "public:deploy_site" }],
      })
    ).toEqual({ scope: "once" })
    expect(humanOutboundGrant(true)).toEqual({ scope: "once" })
  })
})

describe("answerWithOutboundPolicy", () => {
  it("answers an origin-thread reply itself and a fenced one with the fence", async () => {
    const respond = jest.fn()
    await expect(answerWithOutboundPolicy(send(THREAD_KEY), options(), respond)).resolves.toEqual({
      decision: "allow",
      attribution: { authority: "policy-default" },
    })
    expect(respond).not.toHaveBeenCalled()
  })

  it("hands an unauthorized call to the responder per call, and grants a person's allow once", async () => {
    const respond = jest.fn(async () => ({
      decision: "allow_always" as const,
      attribution: { authority: "human" as const },
    }))
    const answer = await answerWithOutboundPolicy(send(OTHER_KEY), options(), respond)
    expect(respond).toHaveBeenCalledWith(
      expect.objectContaining({
        requiresPerCallApproval: true,
        suppressAlwaysAllowRule: true,
        defaultToNo: true,
        outbound: {
          enforced: true,
          targets: [conversationTarget(OTHER_KEY)],
          unauthorized: [conversationTarget(OTHER_KEY)],
        },
      })
    )
    expect(answer).toEqual({
      decision: "allow",
      attribution: { authority: "human" },
      grant: { scope: "once" },
    })
  })

  it("grants the rest of the request when the person allowed it for the request", async () => {
    const answer = await answerWithOutboundPolicy(send(OTHER_KEY), options(), async () => ({
      decision: "allow" as const,
      forRequest: true,
    }))
    expect(answer).toEqual({ decision: "allow", grant: { scope: "instruction" } })
  })

  it("never lets a responder name its own grant, or grant a refusal", async () => {
    const forged = await answerWithOutboundPolicy(send(OTHER_KEY), options(), async () => ({
      decision: "allow" as const,
      grant: { scope: "instruction" as const },
    }))
    expect(forged).toEqual({ decision: "allow", grant: { scope: "once" } })
    const refused = await answerWithOutboundPolicy(send(OTHER_KEY), options(), async () => ({
      decision: "deny" as const,
      forRequest: true,
    }))
    expect(refused).toEqual({ decision: "deny" })
  })

  it("passes a tool that is not outbound, and shadow mode, straight through", async () => {
    const respond = jest.fn(async () => ({ decision: "allow" as const }))
    const write = { ...send(OTHER_KEY), toolName: "mcp__cognia-tools__write" }
    await answerWithOutboundPolicy(write, options(), respond)
    expect(respond).toHaveBeenLastCalledWith(write)
    const request = send(OTHER_KEY)
    await answerWithOutboundPolicy(request, options({ settings: () => ({}) }), respond)
    expect(respond).toHaveBeenLastCalledWith(request)
  })

  it("leaves the call to a person when planning fails under enforcement", async () => {
    const respond = jest.fn(async () => ({ decision: "deny" as const }))
    const failing = options({
      origin: async () => {
        throw new Error("no origin")
      },
    })
    await answerWithOutboundPolicy(send(OTHER_KEY), failing, respond)
    expect(respond).toHaveBeenCalledWith(expect.objectContaining({ requiresPerCallApproval: true }))
  })
})

describe("planOutboundAsk", () => {
  it("answers an enforced allow through the caller's approve", async () => {
    const approve = jest.fn(async () => {})
    await expect(planOutboundAsk(send(THREAD_KEY), options(), approve)).resolves.toEqual({
      answered: true,
    })
    expect(approve).toHaveBeenCalledWith("allow", undefined, { authority: "policy-default" })
  })

  it("leaves an unauthorized call to a person and names its recipient", async () => {
    const approve = jest.fn(async () => {})
    const ask = await planOutboundAsk(send(OTHER_KEY), options(), approve)
    expect(approve).not.toHaveBeenCalled()
    expect(ask).toEqual({
      answered: false,
      personOnly: true,
      review: {
        enforced: true,
        targets: [conversationTarget(OTHER_KEY)],
        unauthorized: [conversationTarget(OTHER_KEY)],
      },
    })
  })

  it("changes nothing in shadow mode", async () => {
    const ask = await planOutboundAsk(
      send(OTHER_KEY),
      options({ settings: () => ({}) }),
      async () => {}
    )
    expect(ask).toMatchObject({ answered: false, personOnly: false, review: { enforced: false } })
  })
})

describe("recordOutboundShadowObservation", () => {
  it("writes a receipt with the plan for a call a shortcut let through", async () => {
    await recordOutboundShadowObservation(
      {
        sessionId: "chat",
        toolUseID: "tu-1",
        toolName: "mcp__cognia-plugin-tools__connectors_send_message",
        input: { conversationKey: OTHER_KEY, text: "hi" },
      },
      options({ settings: () => ({}) })
    )
    const [row] = await receipts()
    expect(row.id).toBe("explicit:tu-1")
    expect(row.request.plan).toEqual({ outcome: "ask", enforced: false })
    expect(row.request.verdict).toBe("allow")
    expect(row.decision).toMatchObject({ outcome: "allow", authority: "policy-rule" })
    expect(row.request.subject.targets).toHaveLength(1)
  })
})

describe("the authorized call, for the delivery it makes (ADR-0239)", () => {
  const withUse = (key: string, requestId = "r1") => ({
    ...send(key, requestId),
    toolUseID: "toolu_1",
  })

  it("records a policy allow before the caller dispatches it", async () => {
    await answerWithOutboundPolicy(withUse(THREAD_KEY), options(), jest.fn())
    expect(authorizedOutboundToolCall("chat", "toolu_1")).toMatchObject({
      requestId: "r1",
      toolName: "connectors_send_message",
      authority: "policy-default",
      fingerprints: [outboundFingerprint(conversationTarget(THREAD_KEY)!)],
    })
  })

  it("records a person's allow of an ask with its grant, and nothing for a refusal", async () => {
    await answerWithOutboundPolicy(withUse(OTHER_KEY), options(), async () => ({
      decision: "allow" as const,
    }))
    expect(authorizedOutboundToolCall("chat", "toolu_1")).toMatchObject({
      authority: "human",
      grant: { scope: "once" },
    })

    __resetAuthorizedToolCallsForTesting()
    await answerWithOutboundPolicy(withUse(OTHER_KEY, "r2"), options(), async () => ({
      decision: "deny" as const,
    }))
    expect(authorizedOutboundToolCall("chat", "toolu_1")).toBeUndefined()
  })

  it("is in place by the time planOutboundAsk's approve runs", async () => {
    let seen: unknown
    await planOutboundAsk(withUse(THREAD_KEY), options(), async () => {
      seen = authorizedOutboundToolCall("chat", "toolu_1")
    })
    expect(seen).toMatchObject({ authority: "policy-default" })
  })

  it("is recorded by the modal's decision, before its answer is dispatched", async () => {
    await planOutboundAsk(withUse(OTHER_KEY), options(), async () => {})
    expect(authorizedOutboundToolCall("chat", "toolu_1")).toBeUndefined()
    const settling = recordChatToolApprovalDecision(
      { sessionId: "chat", requestId: "r1" },
      "allow",
      { scope: "instruction" }
    )
    // Synchronously, before the first await settles anything.
    expect(authorizedOutboundToolCall("chat", "toolu_1")).toMatchObject({
      authority: "human",
      grant: { scope: "instruction" },
    })
    await settling
  })

  it("remembers nothing for a request that names no tool use", async () => {
    await answerWithOutboundPolicy(send(THREAD_KEY), options(), jest.fn())
    expect(authorizedOutboundToolCall("chat", "r1")).toBeUndefined()
  })
})
