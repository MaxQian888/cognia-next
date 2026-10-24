import type { ActionReviewRequest } from "@cognia/agent-config-types/action-review"

import {
  conversationTarget,
  extractOutboundTargets,
  mailTarget,
  outboundFingerprint,
  publicTarget,
  type OutboundTarget,
} from "./outbound-targets"
import {
  planActionReview,
  type ActionReviewPlanContext,
  type ActionReviewPlanInput,
} from "./policy"

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error("fixture target failed to parse")
  return value
}

const THREAD = must(conversationTarget("lark:bot-a:oc_origin:om_thread"))
const OTHER_GROUP = must(conversationTarget("lark:bot-a:oc_other"))
const LISTED_GROUP = must(conversationTarget("lark:bot-a:oc_listed"))
const MAIL_A = must(mailTarget("A <a@example.com>"))
const UNKNOWN: OutboundTarget = { kind: "unknown", channel: "tool:send_message", recipient: "*" }
const PUBLIC = publicTarget("deploy_site")

const fp = outboundFingerprint

function ctx(overrides: Partial<ActionReviewPlanContext> = {}): ActionReviewPlanContext {
  return {
    mode: "enforce",
    unattended: false,
    via: "tool",
    originFingerprints: new Set([fp(THREAD)]),
    fencedFingerprints: new Set(),
    instructionGrants: new Set(),
    policyGrants: new Map(),
    ...overrides,
  }
}

function input(
  targets: readonly OutboundTarget[],
  verdict: ActionReviewPlanInput["verdict"] = "ask"
): ActionReviewPlanInput {
  return { verdict, targets }
}

describe("planActionReview: ADR-0239 verification obligations", () => {
  it.each([
    {
      name: "an undelivered draft to A asks a watching person",
      targets: [MAIL_A],
      context: {},
      outcome: "ask",
    },
    {
      name: "an undelivered draft to A parks when nobody watches",
      targets: [MAIL_A],
      context: { unattended: true },
      outcome: "park",
    },
    {
      name: "after a Deny on A, sending to A is refused without asking",
      targets: [MAIL_A],
      context: { fencedFingerprints: new Set([fp(MAIL_A)]) },
      outcome: "deny",
    },
    {
      name: "an IM answer into the thread it came from needs no card",
      targets: [THREAD],
      context: {},
      outcome: "allow",
    },
    {
      name: "the same agent sending to another group asks",
      targets: [OTHER_GROUP],
      context: {},
      outcome: "ask",
    },
    {
      name: "a scheduled delivery to an unlisted group drafts",
      targets: [OTHER_GROUP],
      context: {
        unattended: true,
        via: "delivery" as const,
        originFingerprints: new Set<string>(),
      },
      outcome: "draft",
    },
    {
      name: "a scheduled delivery to a listed group sends",
      targets: [LISTED_GROUP],
      context: {
        unattended: true,
        via: "delivery" as const,
        originFingerprints: new Set<string>(),
        policyGrants: new Map([[fp(LISTED_GROUP), "bot:b1"]]),
      },
      outcome: "allow",
    },
  ])("$name", ({ targets, context, outcome }) => {
    expect(planActionReview(input(targets), ctx(context)).plan).toEqual({
      outcome,
      enforced: true,
    })
  })

  it("fences A on another tool and on a reworded message", () => {
    const fence = ctx({ fencedFingerprints: new Set([fp(OTHER_GROUP)]) })
    const viaBroadcast = extractOutboundTargets("im_broadcast", {
      conversationKeys: ["lark:bot-a:oc_other:om_any"],
      text: "first wording",
    })
    const viaSend = extractOutboundTargets("connectors_send_message", {
      conversationKey: "lark:bot-a:oc_other",
      text: "a different wording",
    })
    for (const targets of [viaBroadcast, viaSend]) {
      expect(planActionReview(input(targets), fence)).toMatchObject({
        plan: { outcome: "deny" },
        reason: "fenced",
        authority: "policy-deny",
      })
    }
  })
})

describe("planActionReview: order and authority", () => {
  it("lets a ruleset deny win over the origin thread and every grant", () => {
    const granted = ctx({
      instructionGrants: new Set([fp(THREAD)]),
      policyGrants: new Map([[fp(THREAD), "bot:b1"]]),
    })
    expect(planActionReview(input([THREAD], "deny"), granted)).toMatchObject({
      plan: { outcome: "deny" },
      reason: "ruleset-deny",
      authority: "policy-deny",
    })
  })

  it("lets the fence win over the origin thread and every grant", () => {
    const result = planActionReview(
      input([THREAD]),
      ctx({
        fencedFingerprints: new Set([fp(THREAD)]),
        instructionGrants: new Set([fp(THREAD)]),
        policyGrants: new Map([[fp(THREAD), "bot:b1"]]),
      })
    )
    expect(result).toMatchObject({ plan: { outcome: "deny" }, fenced: [THREAD] })
  })

  it("denies the whole action when any one target is fenced, and names it", () => {
    const result = planActionReview(
      input([THREAD, OTHER_GROUP, LISTED_GROUP]),
      ctx({ fencedFingerprints: new Set([fp(OTHER_GROUP)]) })
    )
    expect(result.plan.outcome).toBe("deny")
    expect(result.fenced).toEqual([OTHER_GROUP])
  })

  it("names the origin thread's allow as a default, with no grant", () => {
    expect(planActionReview(input([THREAD]), ctx())).toEqual({
      plan: { outcome: "allow", enforced: true },
      reason: "authorized",
      authority: "policy-default",
      fenced: [],
      unauthorized: [],
    })
  })

  it("names an instruction grant as the person's", () => {
    expect(
      planActionReview(input([OTHER_GROUP]), ctx({ instructionGrants: new Set([fp(OTHER_GROUP)]) }))
    ).toMatchObject({ authority: "human", grant: { scope: "instruction" } })
  })

  it("names a policy grant by the list that holds it", () => {
    expect(
      planActionReview(
        input([OTHER_GROUP]),
        ctx({ policyGrants: new Map([[fp(OTHER_GROUP), "adapter:bot-a"]]) })
      )
    ).toMatchObject({
      authority: "policy-rule",
      grant: { scope: "policy", policyRef: "adapter:bot-a" },
    })
  })

  it("allows a mix of the origin thread and granted targets", () => {
    expect(
      planActionReview(
        input([THREAD, OTHER_GROUP]),
        ctx({ instructionGrants: new Set([fp(OTHER_GROUP)]) })
      )
    ).toMatchObject({ plan: { outcome: "allow" }, grant: { scope: "instruction" } })
  })

  it("asks for every target nothing authorized, and lists only those", () => {
    const result = planActionReview(input([THREAD, OTHER_GROUP, MAIL_A]), ctx())
    expect(result.plan.outcome).toBe("ask")
    expect(result.reason).toBe("unauthorized")
    expect(result.unauthorized).toEqual([OTHER_GROUP, MAIL_A])
  })
})

describe("planActionReview: what never authorizes", () => {
  it.each([
    ["a ruleset allow", "allow"],
    ["bypass mode, which reaches the engine as an allow verdict", "allow"],
    ["an ask verdict", "ask"],
  ] as const)("does not loosen on %s", (_name, verdict) => {
    expect(planActionReview(input([OTHER_GROUP], verdict), ctx()).plan.outcome).toBe("ask")
  })

  it.each([
    ["unknown", UNKNOWN],
    ["public", PUBLIC],
  ])("never grants an %s target for the instruction or by policy", (_kind, target) => {
    const result = planActionReview(
      input([target]),
      ctx({
        originFingerprints: new Set([fp(target)]),
        instructionGrants: new Set([fp(target)]),
        policyGrants: new Map([[fp(target), "bot:b1"]]),
      })
    )
    expect(result.plan.outcome).toBe("ask")
    expect(result.unauthorized).toEqual([target])
  })

  it("still fences an unknown target a person refused", () => {
    expect(
      planActionReview(input([UNKNOWN]), ctx({ fencedFingerprints: new Set([fp(UNKNOWN)]) })).plan
        .outcome
    ).toBe("deny")
  })

  it("treats only a conversation as the origin thread", () => {
    const person: OutboundTarget = {
      kind: "person",
      channel: "bot-a",
      recipient: "person:bot-a:ou_1",
    }
    expect(
      planActionReview(input([person]), ctx({ originFingerprints: new Set([fp(person)]) })).plan
        .outcome
    ).toBe("ask")
  })

  it.each([
    [false, "tool", "ask"],
    [true, "tool", "park"],
    [true, "delivery", "draft"],
    [false, "delivery", "ask"],
  ] as const)(
    "never allows an action with no target (unattended %s, via %s)",
    (unattended, via, outcome) => {
      expect(planActionReview(input([]), ctx({ unattended, via }))).toMatchObject({
        plan: { outcome },
        reason: "no-target",
      })
    }
  )

  it("never reads the model's recommendation", () => {
    const base: ActionReviewPlanInput = input([OTHER_GROUP])
    const withOpinion = {
      ...base,
      recommendation: { suggests: "allow", confidence: "high", source: "judge" },
    } satisfies ActionReviewPlanInput & Pick<ActionReviewRequest, "recommendation">
    expect(planActionReview(withOpinion, ctx())).toEqual(planActionReview(base, ctx()))
  })
})

describe("planActionReview: shadow mode", () => {
  it("plans the same outcome and marks it unenforced", () => {
    const shadow = ctx({ mode: "shadow" })
    for (const [targets, outcome] of [
      [[THREAD], "allow"],
      [[OTHER_GROUP], "ask"],
    ] as const) {
      expect(planActionReview(input(targets), shadow).plan).toEqual({ outcome, enforced: false })
    }
    expect(
      planActionReview(input([MAIL_A]), { ...shadow, fencedFingerprints: new Set([fp(MAIL_A)]) })
        .plan
    ).toEqual({ outcome: "deny", enforced: false })
  })
})
