/** @jest-environment jsdom */

/**
 * Rule 7 pin for ADR-0239's intentionally inert mode: in shadow mode the
 * engine records what it would do and changes no send result. Every scenario
 * here is one enforcement changes; shadow mode must leave each exactly as it
 * was before the engine existed. The type (`agentPermissions.
 * outboundAuthorization`) and the Settings card ("Observe only") name this
 * test.
 */

import { actionReviewAuthKeyPrefix } from "@/lib/db/action-review-receipts"
import { createDbTestFixture } from "@/lib/db/test-fixture"

import { __resetAuthorizedToolCallsForTesting } from "./authorized-tool-calls"
import { __resetRunningBotGrantsForTesting } from "./configured-grants"
import {
  conversationTarget,
  outboundFingerprint,
  repositoryTarget,
  siteTarget,
} from "./outbound-targets"
import { buildActionReviewPlanContext } from "./plan-context"
import { planDelivery, type DeliveryPlanInput, type PlanDeliveryDeps } from "./plan-delivery"
import { outboundToolDecision, planOutboundToolCall } from "./plan-tool-call"
import { planActionReview, readOutboundAuthorizationMode } from "./policy"
import { __clearRequestOriginCacheForTesting } from "./resolve-request-origin"

jest.mock("@/lib/collab/shared-run-coordinator", () => ({
  getSharedRunRequester: () => undefined,
}))

const dbFixture = createDbTestFixture()
beforeAll(dbFixture.initialize)
beforeEach(async () => {
  await dbFixture.restore()
  __resetAuthorizedToolCallsForTesting()
  __resetRunningBotGrantsForTesting()
  __clearRequestOriginCacheForTesting()
})
afterAll(dbFixture.dispose)

const ORIGIN_KEY = "lark:bot-a:oc_origin"
const OTHER_KEY = "lark:bot-a:oc_other"
const ORIGIN = conversationTarget(ORIGIN_KEY)!

const ENFORCE = { agentPermissions: { outboundAuthorization: "enforce" } }
const SHADOW_SETTINGS = [
  {},
  { agentPermissions: {} },
  { agentPermissions: { outboundAuthorization: "shadow" } },
  // Anything but exactly `enforce` observes.
  { agentPermissions: { outboundAuthorization: "on" } },
]

const FENCE = actionReviewAuthKeyPrefix("deny", "root-1", "epoch-1")

function deps(settings: object): PlanDeliveryDeps {
  return {
    settings: () => settings,
    listAuthKeys: async (prefix) =>
      prefix === FENCE ? [`${FENCE}${outboundFingerprint(ORIGIN)}`] : [],
    resolveSessionOrigin: async () => ({
      rootSessionId: "root-1",
      instructionEpoch: "epoch-1",
      originThread: ORIGIN,
    }),
    configuredGrants: async () => [],
    now: () => 1,
  }
}

const DELIVERIES: [string, DeliveryPlanInput][] = [
  [
    "an unattended send to a recipient nothing authorized",
    {
      adapterId: "bot-a",
      conversationKey: OTHER_KEY,
      source: "ai-run",
      authorization: { kind: "unattended", ownerRef: "task:t1" },
    },
  ],
  [
    "a send to a recipient a person refused",
    {
      adapterId: "bot-a",
      conversationKey: ORIGIN_KEY,
      source: "ai-run",
      authorization: { kind: "unattended", ownerRef: "task:t1", sessionId: "s1" },
    },
  ],
  [
    "a reply addressed to another conversation",
    {
      adapterId: "bot-a",
      conversationKey: OTHER_KEY,
      source: "ai-run",
      authorization: { kind: "origin-reply", inboundConversationKey: ORIGIN_KEY },
    },
  ],
  [
    "a tool's delivery with no record of the call",
    {
      adapterId: "bot-a",
      conversationKey: OTHER_KEY,
      source: "ai-run",
      authorization: { kind: "tool-call", sessionId: "s1", toolUseId: "tu-unknown" },
    },
  ],
]

describe("shadow mode changes no send result (ADR-0239)", () => {
  it("reads every setting but exactly `enforce` as shadow", () => {
    for (const settings of SHADOW_SETTINGS) {
      expect(readOutboundAuthorizationMode(settings)).toBe("shadow")
    }
    expect(readOutboundAuthorizationMode(ENFORCE)).toBe("enforce")
  })

  it.each(DELIVERIES)("sends %s", async (_name, input) => {
    // The scenario is one enforcement changes...
    const enforced = await planDelivery(input, deps(ENFORCE))
    expect(enforced.action).not.toBe("send")
    // ...and shadow mode sends it, as before the engine existed.
    for (const settings of SHADOW_SETTINGS) {
      const observed = await planDelivery(input, deps(settings))
      expect(observed.action).toBe("send")
    }
  })

  it("keeps GitHub and browser writes observed until their own category is enforced", async () => {
    // Phase 2 categories start in shadow even where messaging is enforced, so
    // an upgrade never starts holding GitHub or browser writes on its own.
    for (const settings of [...SHADOW_SETTINGS, ENFORCE]) {
      expect(readOutboundAuthorizationMode(settings, "github")).toBe("shadow")
      expect(readOutboundAuthorizationMode(settings, "browser")).toBe("shadow")
      const context = await buildActionReviewPlanContext({
        origin: {},
        unattended: true,
        via: "tool",
        settings,
      })
      for (const target of [repositoryTarget("acme/web")!, siteTarget("https://a.example")!]) {
        expect(planActionReview({ verdict: "ask", targets: [target] }, context).plan).toEqual({
          outcome: "park",
          enforced: false,
        })
      }
    }
  })

  it("leaves a tool call to the permission flow it had", async () => {
    const call = {
      sessionId: "chat",
      requestId: "r1",
      toolName: "mcp__cognia-plugin-tools__connectors_send_message",
      input: { conversationKey: OTHER_KEY, text: "hello" },
    }
    const origin = {
      rootSessionId: "chat",
      instructionEpoch: "msg:u1",
      originThread: ORIGIN,
    }
    const enforced = await planOutboundToolCall(call, {
      unattended: true,
      settings: () => ENFORCE,
      origin,
    })
    expect(enforced && outboundToolDecision(enforced, call.toolName).kind).not.toBe("unchanged")
    for (const settings of SHADOW_SETTINGS) {
      const observed = await planOutboundToolCall(
        { ...call, requestId: `r-${JSON.stringify(settings)}` },
        { unattended: true, settings: () => settings, origin }
      )
      expect(observed && outboundToolDecision(observed, call.toolName)).toEqual({
        kind: "unchanged",
      })
    }
  })
})
