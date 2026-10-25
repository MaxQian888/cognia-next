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
  __resetIntegrationRegistryForTesting,
  integrationToolName,
  registerIntegrationDefinitions,
} from "@/lib/integrations/registry"

import {
  __resetAuthorizedToolCallsForTesting,
  authorizedOutboundToolCall,
  beginOutboundToolExecution,
} from "./authorized-tool-calls"
import {
  conversationTarget,
  outboundFingerprint,
  repositoryTarget,
  unknownGithubTarget,
} from "./outbound-targets"
import { planIntegrationWrite } from "./plan-integration"
import { taskPlanOrigin } from "./plan-context"
import {
  answerWithOutboundPolicy,
  humanOutboundGrant,
  isOutboundToolCall,
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

describe("configured recipient lists (ADR-0239 policy grants)", () => {
  const other = conversationTarget(OTHER_KEY)!
  const listed = {
    recipient: {
      kind: "conversation" as const,
      channel: other.channel,
      recipient: other.recipient,
    },
    addedAt: 1,
    addedBy: "local-user" as const,
  }

  it("lets an unattended call reach a recipient the bot account's list names", async () => {
    await getDb().adapterInstances.put({
      id: "bot-a",
      type: "lark",
      displayName: "Bot A",
      enabled: true,
      transportMode: "longpoll",
      settings: {},
      credentialsRef: { keyringService: "cognia", accounts: [] },
      trigger: { rules: [], blockers: [], storeUnmatchedInDraftMode: false },
      defaultMode: "auto",
      mediaModelPolicy: "local_extract_only",
      outboundRecipients: [listed],
      createdAt: 1,
      updatedAt: 1,
    } as never)
    const plan = await planOutboundToolCall(send(OTHER_KEY), options({ unattended: true }))
    expect(plan?.result).toMatchObject({
      reason: "authorized",
      authority: "policy-rule",
      grant: { scope: "policy", policyRef: "adapter:bot-a" },
    })
  })

  it("adds the run's own list (a Bot's) to the configured ones", async () => {
    const configuredGrants = jest.fn(async () => [])
    const plan = await planOutboundToolCall(
      send(OTHER_KEY),
      options({
        unattended: true,
        configuredGrants,
        policyGrants: [{ policyRef: "bot:boti_1", fingerprints: [outboundFingerprint(other)] }],
      })
    )
    expect(configuredGrants).toHaveBeenCalledWith([other])
    expect(plan?.result.grant).toEqual({ scope: "policy", policyRef: "bot:boti_1" })
  })

  it("parks an unattended call to a recipient no list names", async () => {
    const plan = await planOutboundToolCall(
      send(OTHER_KEY),
      options({ unattended: true, configuredGrants: async () => [] })
    )
    expect(plan?.result.plan).toEqual({ outcome: "park", enforced: true })
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

describe("GitHub writes (ADR-0239 phase 2)", () => {
  const GITHUB_ENFORCE = {
    agentPermissions: { outboundAuthorizationByCategory: { github: "enforce" } },
  }
  const PR_12 = repositoryTarget("acme/web", 12)!
  const comment = `mcp__cognia-plugin-tools__${integrationToolName("github-delivery", "github", "commentPr")}`
  const read = integrationToolName("github-delivery", "github", "getIssue")

  beforeEach(() => {
    __resetIntegrationRegistryForTesting()
    const action = (id: string, risk: "read" | "write") => ({
      id,
      label: id,
      handler: id,
      inputSchema: {},
      risk,
      idempotency: "required" as const,
      scopeSelectors: [{ kind: "repository", jsonPointer: "/repoFullName" }],
    })
    registerIntegrationDefinitions({
      pluginId: "github-delivery",
      definitions: [
        {
          id: "github",
          label: "GitHub",
          authStrategies: [],
          resourceKinds: [],
          eventTypes: [],
          actions: [action("commentPr", "write"), action("getIssue", "read")],
        },
      ],
      handlers: { "github:commentPr": async () => ({}), "github:getIssue": async () => ({}) },
    })
  })
  afterEach(() => __resetIntegrationRegistryForTesting())

  function github(extra: Partial<OutboundToolPlannerOptions> = {}): OutboundToolPlannerOptions {
    return {
      unattended: false,
      settings: () => GITHUB_ENFORCE,
      origin: { rootSessionId: "chat", instructionEpoch: "msg:u1", originThread: PR_12 },
      github: {
        accountHost: async () => "github.com",
        localRepository: async () => "git@github.com:acme/web.git",
      },
      ...extra,
    }
  }
  const call = (toolName: string, input: Record<string, unknown>, requestId = "r1") => ({
    sessionId: "chat",
    requestId,
    toolName,
    input,
  })
  const commentOn = (prNumber: number, requestId = "r1") =>
    call(comment, { accountId: "acct", repoFullName: "acme/web", prNumber, body: "hi" }, requestId)

  it("reviews GitHub write tools and shell gh writes, and nothing else new", () => {
    expect(isOutboundToolCall(comment, {})).toBe(true)
    expect(isOutboundToolCall(read, {})).toBe(false)
    expect(isOutboundToolCall("Bash", { command: "gh pr merge 3 -R acme/web" })).toBe(true)
    expect(isOutboundToolCall("Bash", { command: "gh pr view 3" })).toBe(false)
    expect(isOutboundToolCall("Bash", { command: "ls" })).toBe(false)
    expect(isOutboundToolCall("mcp__other__commentpr", {})).toBe(false)
    expect(isOutboundToolCall("send_message", {})).toBe(true)
  })

  it("answers a reply on the PR the request came from, and asks for another with its thread", async () => {
    const respond = jest.fn(async () => ({ decision: "allow" as const, forRequest: true }))
    await expect(answerWithOutboundPolicy(commentOn(12), github(), respond)).resolves.toEqual({
      decision: "allow",
      attribution: { authority: "policy-default" },
    })
    expect(respond).not.toHaveBeenCalled()

    const answer = await answerWithOutboundPolicy(commentOn(13, "r2"), github(), respond)
    expect(respond).toHaveBeenCalledWith(
      expect.objectContaining({
        requiresPerCallApproval: true,
        suppressAlwaysAllowRule: true,
        outbound: {
          enforced: true,
          targets: [
            {
              kind: "repository",
              channel: "github",
              recipient: "github:github.com/acme/web",
              thread: "13",
            },
          ],
          unauthorized: [expect.objectContaining({ thread: "13" })],
        },
      })
    )
    // The widest grant is the rest of the request, for the whole repository.
    expect(answer).toEqual({ decision: "allow", grant: { scope: "instruction" } })
  })

  it("names the account's GitHub Enterprise host", async () => {
    const plan = await planOutboundToolCall(
      commentOn(4),
      github({ github: { accountHost: async () => "ghe.corp.io" } })
    )
    expect(plan?.targets).toEqual([repositoryTarget("ghe.corp.io/acme/web", 4)])
  })

  it("puts a gh write that names no repository on the session's checkout", async () => {
    const plan = await planOutboundToolCall(
      call("Bash", { command: "gh pr comment 12 -b thanks" }),
      github()
    )
    expect(plan?.targets).toEqual([PR_12])
    expect(plan && outboundToolDecision(plan, "Bash")).toMatchObject({ kind: "allow" })

    // After a `cd`, the checkout is not known: never granted, always asked.
    const moved = await planOutboundToolCall(
      call("Bash", { command: "cd ../api && gh pr comment 12 -b thanks" }, "r2"),
      github()
    )
    expect(moved?.targets).toEqual([unknownGithubTarget()])
    expect(moved && outboundToolDecision(moved, "Bash")).toEqual({ kind: "ask" })
    const outsideCheckout = await planOutboundToolCall(
      call("Bash", { command: "gh pr create --fill" }, "r3"),
      github({ github: { localRepository: async () => undefined } })
    )
    expect(outsideCheckout?.targets).toEqual([unknownGithubTarget()])
  })

  it("is enforced by the GitHub category, not by messaging", async () => {
    const messagingOnly = github({ settings: () => ENFORCE })
    const plan = await planOutboundToolCall(commentOn(13), messagingOnly)
    expect(plan?.result.plan.enforced).toBe(false)
    const ask = await planOutboundAsk(commentOn(13, "r2"), messagingOnly, jest.fn())
    expect(ask).toMatchObject({ answered: false, personOnly: false })
  })

  it("leaves the call to a person when planning fails under GitHub enforcement", async () => {
    const error = jest.spyOn(console, "error").mockImplementation(() => undefined)
    const failing = github({
      origin: async () => {
        throw new Error("db closed")
      },
    })
    await expect(planOutboundAsk(commentOn(13), failing, jest.fn())).resolves.toEqual({
      answered: false,
      personOnly: true,
    })
    await expect(
      planOutboundAsk(commentOn(13), { ...failing, settings: () => ENFORCE }, jest.fn())
    ).resolves.toEqual({ answered: false, personOnly: false })
    error.mockRestore()
  })

  it("fences the repository after a person's Deny on its card, on any PR", async () => {
    await openChatToolReview({ sessionId: "chat", requestId: "r1", toolName: comment })
    await planOutboundToolCall(commentOn(13, "r1"), github())
    await recordChatToolApprovalDecision({ sessionId: "chat", requestId: "r1" }, "deny")
    const again = await planOutboundToolCall(commentOn(12, "r2"), github())
    expect(again?.result.plan.outcome).toBe("deny")
  })

  it("records a shell gh write a shortcut let through in shadow mode", async () => {
    await recordOutboundShadowObservation(
      {
        sessionId: "chat",
        toolUseID: "tu-gh",
        toolName: "Bash",
        input: { command: "gh pr merge 13 --squash -R acme/web" },
      },
      github({ settings: () => ({}) })
    )
    const [row] = await receipts()
    expect(row).toMatchObject({
      id: "explicit:tu-gh",
      request: {
        plan: { outcome: "ask", enforced: false },
        subject: {
          targets: [{ channel: "github", fingerprint: outboundFingerprint(PR_12) }],
        },
      },
    })
  })

  it("lets the broker run the job of a call a person allowed, without asking again", async () => {
    const request = { ...commentOn(13), toolUseID: "toolu_gh" }
    await answerWithOutboundPolicy(request, github(), async () => ({ decision: "allow" as const }))
    beginOutboundToolExecution("chat", "toolu_gh", "plugin:github-delivery")
    await expect(
      planIntegrationWrite(
        {
          targets: [repositoryTarget("acme/web", 13)!],
          operation: "github.commentPr",
          authorization: { kind: "tool-call", pluginId: "github-delivery", sessionId: "chat" },
        },
        {
          settings: () => GITHUB_ENFORCE,
          resolveSessionOrigin: async () => ({ rootSessionId: "chat", instructionEpoch: "msg:u1" }),
          listAuthKeys: async () => [],
        }
      )
    ).resolves.toMatchObject({
      action: "proceed",
      authorizedBy: { receiptId: "r1", authority: "human", grantScope: "once" },
    })
  })
})
