import {
  isActionReviewDecision,
  isActionReviewRequest,
} from "@cognia/agent-config-types/action-review"

import { actionReviewAuthKeyPrefix } from "@/lib/db/action-review-receipts"

import {
  __resetAuthorizedToolCallsForTesting,
  authorizeOutboundToolCall,
  beginOutboundToolExecution,
  rememberPlannedOutboundToolCall,
} from "./authorized-tool-calls"
import { __resetRunningBotGrantsForTesting, beginBotOutboundRun } from "./configured-grants"
import { botPlanOrigin } from "./plan-context"
import {
  conversationTarget,
  outboundFingerprint,
  personTarget,
  toReviewTarget,
} from "./outbound-targets"
import {
  planDelivery,
  planUnplannedStream,
  sameChat,
  type DeliveryPlanInput,
  type PlanDeliveryDeps,
} from "./plan-delivery"

const ORIGIN_KEY = "lark:bot-a:oc_origin"
const OTHER_KEY = "lark:bot-a:oc_other"
const ORIGIN = conversationTarget(ORIGIN_KEY)!
const OTHER = conversationTarget(OTHER_KEY)!

const enforce = { agentPermissions: { outboundAuthorization: "enforce" } }
const shadow = { agentPermissions: {} }

function deps(
  settings: object,
  keys: Record<string, string[]> = {},
  extra: Partial<PlanDeliveryDeps> = {}
): PlanDeliveryDeps {
  let seq = 0
  return {
    settings: () => settings,
    listAuthKeys: async (prefix) => keys[prefix] ?? [],
    resolveSessionOrigin: async () => ({
      rootSessionId: "root-1",
      instructionEpoch: "epoch-1",
      originThread: ORIGIN,
    }),
    configuredGrants: async () => [],
    now: () => 5_000,
    newRequestId: () => `n${++seq}`,
    ...extra,
  }
}

function delivery(
  conversationKey: string,
  authorization?: DeliveryPlanInput["authorization"],
  source: DeliveryPlanInput["source"] = "ai-run"
): DeliveryPlanInput {
  return {
    adapterId: "bot-a",
    conversationKey,
    source,
    ...(authorization ? { authorization } : {}),
  }
}

beforeEach(() => {
  __resetAuthorizedToolCallsForTesting()
  __resetRunningBotGrantsForTesting()
})

describe("sameChat", () => {
  it("matches a chat through any bot and any thread, on the same platform", () => {
    expect(sameChat("lark:bot-a:oc_1", "lark:bot-b:oc_1:om_thread")).toBe(true)
    expect(sameChat("lark:bot-a:oc_1", "lark:bot-a:oc_2")).toBe(false)
    expect(sameChat("lark:bot-a:oc_1", "slack:bot-a:oc_1")).toBe(false)
    expect(sameChat("not a key", "lark:bot-a:oc_1")).toBe(false)
  })
})

describe("planDelivery", () => {
  it("sends a person's own message with no authorization and no receipt", async () => {
    await expect(
      planDelivery(delivery(OTHER_KEY, undefined, "manual"), deps(enforce))
    ).resolves.toEqual({ action: "send" })
  })

  describe("origin-reply and system-notice", () => {
    it.each(["origin-reply", "system-notice"] as const)(
      "%s into its own chat goes, through a sibling bot too",
      async (kind) => {
        await expect(
          planDelivery(
            delivery("lark:bot-b:oc_origin", { kind, inboundConversationKey: ORIGIN_KEY }),
            deps(enforce)
          )
        ).resolves.toEqual({ action: "send", authorizedBy: { authority: "policy-default" } })
      }
    )

    it("refuses a reply to another conversation under enforcement", async () => {
      const decision = await planDelivery(
        delivery(OTHER_KEY, { kind: "origin-reply", inboundConversationKey: ORIGIN_KEY }),
        deps(enforce)
      )
      expect(decision).toMatchObject({ action: "deny", reason: "conversation-mismatch" })
      if (decision.action !== "deny") throw new Error("unreachable")
      expect(decision.receipt.request.plan).toEqual({ outcome: "deny", enforced: true })
      expect(decision.receipt.decision).toMatchObject({ outcome: "deny", authority: "policy-deny" })
    })

    it("only records the mismatch in shadow mode", async () => {
      const decision = await planDelivery(
        delivery(OTHER_KEY, { kind: "system-notice", inboundConversationKey: ORIGIN_KEY }),
        deps(shadow)
      )
      expect(decision.action).toBe("send")
      expect(decision.receipt?.request.plan).toEqual({ outcome: "deny", enforced: false })
      expect(decision.receipt?.decision).toMatchObject({
        outcome: "allow",
        authority: "policy-default",
      })
    })
  })

  describe("unattended", () => {
    it("sends into the origin thread with no receipt", async () => {
      await expect(
        planDelivery(
          delivery(ORIGIN_KEY, { kind: "unattended", ownerRef: "task:t1", sessionId: "s1" }),
          deps(enforce)
        )
      ).resolves.toEqual({ action: "send", authorizedBy: { authority: "policy-default" } })
    })

    it("drafts a delivery nothing authorized, keyed to its session, with a valid receipt", async () => {
      const decision = await planDelivery(
        delivery(OTHER_KEY, { kind: "unattended", ownerRef: "task:t1", sessionId: "s1" }),
        deps(enforce)
      )
      expect(decision).toMatchObject({ action: "draft", draftSessionId: "s1" })
      if (decision.action !== "draft") throw new Error("unreachable")
      const { request, decision: settled } = decision.receipt
      expect(isActionReviewRequest(request)).toBe(true)
      expect(isActionReviewDecision(settled)).toBe(true)
      expect(request).toMatchObject({
        requestId: "delivery:n1",
        origin: {
          channel: "connector-delivery",
          sessionId: "s1",
          rootSessionId: "root-1",
          instructionEpoch: "epoch-1",
          headless: true,
        },
        subject: {
          kind: "connector-delivery",
          ref: "task:t1",
          targets: [{ channel: "bot-a", fingerprint: outboundFingerprint(OTHER) }],
        },
        plan: { outcome: "draft", enforced: true },
      })
      // A draft is not a person's refusal: it must not fence anything.
      expect(settled).toMatchObject({ outcome: "deny", authority: "policy-default" })
    })

    it("sends to a recipient a person granted for this request, with a receipt", async () => {
      const prefix = actionReviewAuthKeyPrefix("grant", "root-1", "epoch-1")
      const decision = await planDelivery(
        delivery(OTHER_KEY, { kind: "unattended", ownerRef: "task:t1", sessionId: "s1" }),
        deps(enforce, { [prefix]: [`${prefix}${outboundFingerprint(OTHER)}`] })
      )
      expect(decision).toMatchObject({
        action: "send",
        authorizedBy: {
          receiptId: "delivery:n1",
          authority: "human",
          grantScope: "instruction",
        },
      })
      expect(decision.receipt?.decision).toMatchObject({
        outcome: "allow",
        grant: { scope: "instruction" },
      })
    })

    it("sends to a recipient on a configured list", async () => {
      const decision = await planDelivery(
        delivery(OTHER_KEY, {
          kind: "unattended",
          ownerRef: "bot:b1",
          origin: { rootSessionId: "bot:b1", instructionEpoch: "bot:b1:1" },
          policyGrants: [{ policyRef: "bot:b1", fingerprints: [outboundFingerprint(OTHER)] }],
        }),
        deps(enforce)
      )
      expect(decision).toMatchObject({
        action: "send",
        authorizedBy: { authority: "policy-rule", grantScope: "policy", policyRef: "bot:b1" },
      })
    })

    it("refuses a fenced recipient, even the origin thread", async () => {
      const prefix = actionReviewAuthKeyPrefix("deny", "root-1", "epoch-1")
      const decision = await planDelivery(
        delivery(ORIGIN_KEY, { kind: "unattended", ownerRef: "n:1", sessionId: "s1" }),
        deps(enforce, { [prefix]: [`${prefix}${outboundFingerprint(ORIGIN)}`] })
      )
      expect(decision).toMatchObject({ action: "deny", reason: "fenced" })
    })

    it("sends in shadow mode and records that enforcement would have drafted it", async () => {
      const decision = await planDelivery(
        delivery(OTHER_KEY, { kind: "unattended", ownerRef: "task:t1" }),
        deps(shadow)
      )
      expect(decision.action).toBe("send")
      expect(decision.receipt?.request.plan).toEqual({ outcome: "draft", enforced: false })
      expect(decision.receipt?.decision.reason).toMatch(/shadow mode/)
    })

    it("does not change a shadow-mode send when planning fails", async () => {
      const warn = jest.spyOn(console, "warn").mockImplementation(() => undefined)
      const failing = {
        resolveSessionOrigin: async () => {
          throw new Error("db closed")
        },
      }
      await expect(
        planDelivery(
          delivery(OTHER_KEY, { kind: "unattended", ownerRef: "x", sessionId: "s1" }),
          deps(shadow, {}, failing)
        )
      ).resolves.toEqual({ action: "send" })
      // Enforcement does not send on a failure.
      await expect(
        planDelivery(
          delivery(OTHER_KEY, { kind: "unattended", ownerRef: "x", sessionId: "s1" }),
          deps(enforce, {}, failing)
        )
      ).resolves.toMatchObject({ action: "draft" })
      warn.mockRestore()
    })

    it("plans an automated source that names no authorization as unattended", async () => {
      await expect(
        planDelivery(delivery(OTHER_KEY, undefined, "plugin"), deps(enforce))
      ).resolves.toMatchObject({ action: "draft", draftSessionId: "source:plugin" })
    })
  })

  describe("tool-call", () => {
    function allowCall(fingerprints: string[], toolName = "im_broadcast") {
      rememberPlannedOutboundToolCall({
        sessionId: "s1",
        requestId: "req_1",
        toolUseId: "toolu_1",
        toolName,
        fingerprints,
      })
      authorizeOutboundToolCall("s1", "req_1", { authority: "human", grant: { scope: "once" } })
    }
    const call = { kind: "tool-call", sessionId: "s1", toolUseId: "toolu_1" } as const

    it("sends a target the authorized call planned, pointing at its receipt", async () => {
      allowCall([outboundFingerprint(OTHER)])
      await expect(
        planDelivery(delivery(OTHER_KEY, call, "skill"), deps(enforce))
      ).resolves.toEqual({
        action: "send",
        authorizedBy: { receiptId: "req_1", authority: "human", grantScope: "once" },
      })
    })

    it("plans a target the call did not name in the session's origin", async () => {
      allowCall([outboundFingerprint(ORIGIN)])
      await expect(
        planDelivery(delivery(OTHER_KEY, call, "skill"), deps(enforce))
      ).resolves.toMatchObject({ action: "draft", draftSessionId: "s1" })
    })

    it("covers the chat a creating tool just made, and only for such a tool", async () => {
      allowCall([], "im_create_chat")
      await expect(
        planDelivery(
          delivery("lark:bot-a:oc_new", { ...call, createdConversation: true }, "skill"),
          deps(enforce)
        )
      ).resolves.toMatchObject({ action: "send", authorizedBy: { receiptId: "req_1" } })

      __resetAuthorizedToolCallsForTesting()
      allowCall([], "im_broadcast")
      await expect(
        planDelivery(
          delivery("lark:bot-a:oc_new", { ...call, createdConversation: true }, "skill"),
          deps(enforce)
        )
      ).resolves.toMatchObject({ action: "draft" })
    })

    it("plans a call the host never authorized as unattended under enforcement", async () => {
      await expect(
        planDelivery(delivery(OTHER_KEY, call, "skill"), deps(enforce))
      ).resolves.toMatchObject({ action: "draft" })
      // …while a reply into the origin thread still goes.
      await expect(
        planDelivery(delivery(ORIGIN_KEY, call, "skill"), deps(enforce))
      ).resolves.toMatchObject({ action: "send" })
    })

    it("records nothing in shadow mode for a call it has no record of", async () => {
      await expect(planDelivery(delivery(OTHER_KEY, call, "skill"), deps(shadow))).resolves.toEqual(
        {
          action: "send",
        }
      )
    })
  })

  describe("configured recipient lists", () => {
    it("sends an unattended delivery a person's list covers, naming the list", async () => {
      const configuredGrants = jest.fn(async () => [
        { policyRef: "adapter:bot-a", fingerprints: [outboundFingerprint(OTHER)] },
      ])
      await expect(
        planDelivery(
          delivery(OTHER_KEY, { kind: "unattended", ownerRef: "task:t1" }),
          deps(enforce, {}, { configuredGrants })
        )
      ).resolves.toMatchObject({
        action: "send",
        authorizedBy: {
          authority: "policy-rule",
          grantScope: "policy",
          policyRef: "adapter:bot-a",
        },
        receipt: expect.any(Object),
      })
      expect(configuredGrants).toHaveBeenCalledWith([OTHER], { conversationKeys: [OTHER_KEY] })
    })

    it("covers a handler Bot's own plugin code only while the Bot runs", async () => {
      const installation = {
        id: "boti_1",
        outboundRecipients: [
          {
            recipient: {
              kind: "conversation" as const,
              channel: OTHER.channel,
              recipient: OTHER.recipient,
            },
            addedAt: 1,
            addedBy: "local-user" as const,
          },
        ],
      }
      const end = beginBotOutboundRun("run-1", { pluginId: "p1", installation })
      const plugin = delivery(
        OTHER_KEY,
        { kind: "plugin", pluginId: "p1", botRunId: "run-1" },
        "plugin"
      )
      await expect(planDelivery(plugin, deps(enforce))).resolves.toMatchObject({
        action: "send",
        authorizedBy: { policyRef: "bot:boti_1" },
      })
      // Another plugin's code is not this Bot's, nor is a call naming no run.
      await expect(
        planDelivery(
          delivery(OTHER_KEY, { kind: "plugin", pluginId: "p2", botRunId: "run-1" }, "plugin"),
          deps(enforce)
        )
      ).resolves.toMatchObject({ action: "draft" })
      await expect(
        planDelivery(
          delivery(OTHER_KEY, { kind: "plugin", pluginId: "p1" }, "plugin"),
          deps(enforce)
        )
      ).resolves.toMatchObject({ action: "draft" })
      end()
      await expect(planDelivery(plugin, deps(enforce))).resolves.toMatchObject({
        action: "draft",
      })
    })

    it("lends each named run its own installation's list, never another's", async () => {
      const listed = (id: string) => ({
        id,
        outboundRecipients: [
          {
            recipient: {
              kind: "conversation" as const,
              channel: OTHER.channel,
              recipient: OTHER.recipient,
            },
            addedAt: 1,
            addedBy: "local-user" as const,
          },
        ],
      })
      const endA = beginBotOutboundRun("run-a", { pluginId: "p1", installation: listed("boti_a") })
      const endB = beginBotOutboundRun("run-b", { pluginId: "p1", installation: { id: "boti_b" } })
      const as = (botRunId: string) =>
        delivery(OTHER_KEY, { kind: "plugin", pluginId: "p1", botRunId }, "plugin")
      // B's code (a callback B left behind included) names B's run, not A's.
      await expect(planDelivery(as("run-b"), deps(enforce))).resolves.toMatchObject({
        action: "draft",
      })
      await expect(planDelivery(as("run-a"), deps(enforce))).resolves.toMatchObject({
        action: "send",
        authorizedBy: { policyRef: "bot:boti_a" },
      })
      endB()
      await expect(planDelivery(as("run-b"), deps(enforce))).resolves.toMatchObject({
        action: "draft",
      })
      endA()
    })

    it("plans a handler Bot's plugin code inside its installation's fence", async () => {
      const installation = {
        id: "boti_1",
        humanRevision: 2,
        outboundRecipients: [
          {
            recipient: {
              kind: "conversation" as const,
              channel: OTHER.channel,
              recipient: OTHER.recipient,
            },
            addedAt: 1,
            addedBy: "local-user" as const,
          },
        ],
      }
      const origin = botPlanOrigin(installation)
      const prefix = actionReviewAuthKeyPrefix(
        "deny",
        origin.rootSessionId!,
        origin.instructionEpoch!
      )
      const end = beginBotOutboundRun("run-1", { pluginId: "p1", installation })
      const decision = await planDelivery(
        delivery(OTHER_KEY, { kind: "plugin", pluginId: "p1", botRunId: "run-1" }, "plugin"),
        deps(enforce, { [prefix]: [`${prefix}${outboundFingerprint(OTHER)}`] })
      )
      expect(decision).toMatchObject({ action: "deny", reason: "fenced" })
      expect(decision.receipt?.request.origin.rootSessionId).toBe(origin.rootSessionId)
      end()
    })
  })

  describe("plugin", () => {
    it("is covered by one of the plugin's running, authorized calls", async () => {
      rememberPlannedOutboundToolCall({
        sessionId: "s1",
        requestId: "req_1",
        toolUseId: "toolu_1",
        toolName: "send_message",
        fingerprints: [outboundFingerprint(OTHER)],
      })
      authorizeOutboundToolCall("s1", "req_1", { authority: "policy-rule" })
      beginOutboundToolExecution("s1", "toolu_1", "plugin:p1")

      await expect(
        planDelivery(
          delivery(OTHER_KEY, { kind: "plugin", pluginId: "p1" }, "plugin"),
          deps(enforce)
        )
      ).resolves.toMatchObject({ action: "send", authorizedBy: { receiptId: "req_1" } })
      // Another plugin cannot ride on it.
      await expect(
        planDelivery(
          delivery(OTHER_KEY, { kind: "plugin", pluginId: "p2" }, "plugin"),
          deps(enforce)
        )
      ).resolves.toMatchObject({ action: "draft", draftSessionId: "plugin:p2" })
    })
  })

  describe("recipients (an urgent push)", () => {
    const A = personTarget("bot-a", "ou_a")!
    const B = personTarget("bot-a", "ou_b")!
    function push(
      authorization: DeliveryPlanInput["authorization"],
      recipients: DeliveryPlanInput["recipients"] = [A, B]
    ): DeliveryPlanInput {
      return {
        ...delivery(OTHER_KEY, authorization, "plugin"),
        immediate: true,
        recipients,
      }
    }
    const listOf = (...targets: (typeof A)[]) =>
      jest.fn(async () => [
        { policyRef: "adapter:bot-a", fingerprints: targets.map(outboundFingerprint) },
      ])

    it("plans the people it notifies, not the conversation, with that conversation's lists", async () => {
      const configuredGrants = listOf(A, B)
      await expect(
        planDelivery(
          push({ kind: "unattended", ownerRef: "sla-escalation:k" }),
          deps(enforce, {}, { configuredGrants })
        )
      ).resolves.toMatchObject({
        action: "send",
        authorizedBy: { policyRef: "adapter:bot-a" },
        receipt: { request: { subject: { targets: [toReviewTarget(A), toReviewTarget(B)] } } },
      })
      expect(configuredGrants).toHaveBeenCalledWith([A, B], { conversationKeys: [OTHER_KEY] })
    })

    it("refuses the push when anyone it notifies is unauthorized", async () => {
      const decision = await planDelivery(
        push({ kind: "unattended", ownerRef: "sla-escalation:k" }),
        deps(enforce, {}, { configuredGrants: listOf(A) })
      )
      expect(decision).toMatchObject({ action: "deny", reason: "unapproved" })
      expect(decision.receipt?.request.subject.targets).toEqual([
        toReviewTarget(A),
        toReviewTarget(B),
      ])
    })

    it("counts a policy grant the sender names for each person", async () => {
      await expect(
        planDelivery(
          push({
            kind: "unattended",
            ownerRef: "sla-escalation:k",
            origin: {},
            policyGrants: [
              {
                policyRef: "escalation:adapter:bot-a",
                fingerprints: [A, B].map(outboundFingerprint),
              },
            ],
          }),
          deps(enforce)
        )
      ).resolves.toMatchObject({
        action: "send",
        authorizedBy: { policyRef: "escalation:adapter:bot-a" },
      })
    })

    it("is covered by a plugin's running call only when the call planned every person", async () => {
      rememberPlannedOutboundToolCall({
        sessionId: "s1",
        requestId: "req_1",
        toolUseId: "toolu_1",
        toolName: "urgent",
        fingerprints: [outboundFingerprint(A)],
      })
      authorizeOutboundToolCall("s1", "req_1", { authority: "policy-rule" })
      beginOutboundToolExecution("s1", "toolu_1", "plugin:p1")
      const plugin = { kind: "plugin", pluginId: "p1" } as const
      await expect(planDelivery(push(plugin, [A]), deps(enforce))).resolves.toMatchObject({
        action: "send",
        authorizedBy: { receiptId: "req_1" },
      })
      await expect(planDelivery(push(plugin, [A, B]), deps(enforce))).resolves.toMatchObject({
        action: "deny",
        reason: "unapproved",
      })
    })

    it("is covered by a tool call only when the call planned every person", async () => {
      rememberPlannedOutboundToolCall({
        sessionId: "s1",
        requestId: "req_1",
        toolUseId: "toolu_1",
        toolName: "im_urgent",
        fingerprints: [outboundFingerprint(A), outboundFingerprint(B)],
      })
      authorizeOutboundToolCall("s1", "req_1", { authority: "human", grant: { scope: "once" } })
      const call = { kind: "tool-call", sessionId: "s1", toolUseId: "toolu_1" } as const
      await expect(planDelivery(push(call), deps(enforce))).resolves.toMatchObject({
        action: "send",
        authorizedBy: { receiptId: "req_1" },
      })
      await expect(
        planDelivery(push(call, [A, personTarget("bot-a", "ou_c")!]), deps(enforce))
      ).resolves.toMatchObject({ action: "deny", reason: "unapproved" })
    })

    it("treats an empty list as an unknown recipient", async () => {
      await expect(
        planDelivery(
          push({ kind: "unattended", ownerRef: "x" }, []),
          deps(enforce, {}, { configuredGrants: listOf(A, B) })
        )
      ).resolves.toMatchObject({ action: "deny", reason: "unapproved" })
    })

    it("sends in shadow mode, recording that enforcement would have refused it", async () => {
      const decision = await planDelivery(push({ kind: "unattended", ownerRef: "x" }), deps(shadow))
      expect(decision.action).toBe("send")
      expect(decision.receipt?.request.plan).toEqual({ outcome: "deny", enforced: false })
    })
  })

  describe("human and rerouted", () => {
    it("sends what a person confirmed, with a receipt under enforcement", async () => {
      const decision = await planDelivery(
        delivery(OTHER_KEY, { kind: "human", actor: "connector-user" }, "skill"),
        deps(enforce)
      )
      expect(decision).toMatchObject({
        action: "send",
        authorizedBy: { authority: "human", grantScope: "once", receiptId: "delivery:n1" },
      })
      expect(decision.receipt?.decision.actor).toEqual({ kind: "connector-user" })
    })

    it("carries a rerouted job's authorization to the same chat only", async () => {
      const authorizedBy = { receiptId: "req_9", authority: "human" as const }
      await expect(
        planDelivery(
          delivery(
            "lark:bot-b:oc_other",
            { kind: "rerouted", from: { conversationKey: OTHER_KEY, authorizedBy } },
            "skill"
          ),
          deps(enforce)
        )
      ).resolves.toEqual({ action: "send", authorizedBy })
      await expect(
        planDelivery(
          delivery(
            "lark:bot-b:oc_elsewhere",
            { kind: "rerouted", from: { conversationKey: OTHER_KEY, authorizedBy } },
            "skill"
          ),
          deps(enforce)
        )
      ).resolves.toMatchObject({ action: "deny", reason: "conversation-mismatch" })
    })
  })
})

describe("planDelivery: a delivery that cannot wait (immediate)", () => {
  const plugin = { kind: "plugin" as const, pluginId: "p1" }
  const immediate = (key: string) => ({ ...delivery(key, plugin, "plugin"), immediate: true })

  it("is refused where another would be drafted, with its receipt", async () => {
    const decision = await planDelivery(immediate(OTHER_KEY), deps(enforce))
    expect(decision).toMatchObject({ action: "deny", reason: "unapproved" })
    expect(decision.receipt?.decision).toMatchObject({ outcome: "deny" })
    expect(decision.receipt?.decision.reason).toMatch(/cannot wait for a person/)
  })

  it("still goes when something authorized its recipient", async () => {
    const named = { ...immediate(OTHER_KEY), authorization: { ...plugin, botRunId: "run-1" } }
    const end = beginBotOutboundRun("run-1", {
      pluginId: "p1",
      installation: {
        id: "boti_1",
        outboundRecipients: [
          {
            recipient: {
              kind: "conversation" as const,
              channel: OTHER.channel,
              recipient: OTHER.recipient,
            },
            addedAt: 1,
            addedBy: "local-user" as const,
          },
        ],
      },
    })
    await expect(planDelivery(named, deps(enforce))).resolves.toMatchObject({
      action: "send",
      authorizedBy: { policyRef: "bot:boti_1" },
    })
    end()
  })

  it("plans a delivery with no conversation as an unknown recipient, which nothing allows", async () => {
    const decision = await planDelivery(immediate(""), deps(enforce))
    expect(decision).toMatchObject({ action: "deny", reason: "unapproved" })
    expect(decision.receipt?.request.subject.targets).toEqual([
      toReviewTarget({ kind: "unknown", channel: "bot-a", recipient: "*" }),
    ])
  })

  it("is sent in shadow mode, recording that enforcement would have refused it", async () => {
    const decision = await planDelivery(immediate(OTHER_KEY), deps(shadow))
    expect(decision.action).toBe("send")
    expect(decision.receipt?.request.plan).toEqual({ outcome: "deny", enforced: false })
    expect(decision.receipt?.decision.reason).toMatch(/would have refused it/)
  })
})

describe("planUnplannedStream (ADR-0239)", () => {
  const stream = { adapterId: "bot-a", ownerRef: "plugin:p1", source: "plugin" } as const

  it("refuses a stream under enforcement, recording nothing", async () => {
    await expect(planUnplannedStream(stream, deps(enforce))).resolves.toEqual({ stream: false })
  })

  it("streams in shadow mode, recording that enforcement would not have", async () => {
    const decision = await planUnplannedStream(stream, deps(shadow))
    expect(decision.stream).toBe(true)
    const receipt = decision.receipt!
    expect(isActionReviewRequest(receipt.request)).toBe(true)
    expect(isActionReviewDecision(receipt.decision)).toBe(true)
    expect(receipt.request).toMatchObject({
      requestId: "delivery:n1",
      origin: { channel: "connector-delivery", headless: true },
      subject: {
        kind: "connector-delivery",
        ref: "plugin:p1",
        targets: [toReviewTarget({ kind: "unknown", channel: "bot-a", recipient: "*" })],
      },
      plan: { outcome: "deny", enforced: false },
      requestedAt: 5_000,
    })
    expect(receipt.decision).toMatchObject({ outcome: "allow", authority: "policy-default" })
    expect(receipt.decision.reason).toContain("would not have let it stream")
  })
})
