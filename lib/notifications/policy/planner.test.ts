// Coverage for the pure planner (V2): the deny-first decision order
//   A expiry → B subscription match → C target → D route rules → E quiet
//   hours → F suppression/duplicate → G notify. Each verdict carries a
//   structured reasonCode; the outcome is the best route kind by severity.

import { planNotification, type PlannerFact, type PlannerInput } from "./planner"
import type { NotificationSubscription } from "@/types/notifications/subscription"
import type { NotificationTarget } from "@/types/notifications/target"
import type { NotificationPolicyContext } from "@/types/notifications/decision"
import type { NotificationDeliveryIntent } from "@/types/notifications/delivery"

const SCOPE = { namespaceId: "n", accountId: "acct", authorityHostId: "h" }

function policy(over: Partial<NotificationPolicyContext> = {}): NotificationPolicyContext {
  return {
    policyVersion: 1,
    timezone: "UTC",
    quietHoursEnabled: false,
    quietHoursStart: "22:00",
    quietHoursEnd: "08:00",
    quietHoursAllowCritical: true,
    osThreshold: "info",
    pushThreshold: "info",
    ...over,
  }
}

function fact(over: Partial<PlannerFact> = {}): PlannerFact {
  return {
    factKey: over.factKey ?? "run:r1:terminal",
    category: over.category ?? "run.terminal",
    purpose: over.purpose ?? "terminal-state",
    level: over.level ?? "info",
    source: over.source ?? "run",
    ...(over.runId ? { runId: over.runId } : { runId: "r1" }),
    ...(over.principalId ? { principalId: over.principalId } : {}),
    ...(over.materialHash ? { materialHash: over.materialHash } : {}),
    ...(over.validUntil !== undefined ? { validUntil: over.validUntil } : {}),
    ...(over.maxClassification ? { maxClassification: over.maxClassification } : {}),
  }
}

function target(over: Partial<NotificationTarget> = {}): NotificationTarget {
  return {
    id: over.id ?? "t1",
    version: 1,
    scope: SCOPE,
    scopeKey: "n::acct::",
    label: "t",
    address: over.address ?? { kind: "feishu-webhook", endpointSecretRef: "x", region: "feishu" },
    addressFingerprint: "fp",
    enabled: over.enabled ?? true,
    enabledKey: over.enabled === false ? 0 : 1,
    consent: over.consent ?? { mode: "proactive", grantRef: "g", grantedBy: "me", grantedAt: 0 },
    disclosureProfileId: over.disclosureProfileId ?? "internal",
    locale: "en",
    timezone: "UTC",
    createdAt: 0,
    updatedAt: 0,
    ...(over.deletedAt !== undefined ? { deletedAt: over.deletedAt } : {}),
  }
}

function sub(over: Partial<NotificationSubscription> = {}): NotificationSubscription {
  return {
    id: over.id ?? "s1",
    version: 1,
    scope: SCOPE,
    scopeKey: "n::acct::",
    principalId: over.principalId ?? "acct",
    binding: over.binding ?? { kind: "scope" },
    targetIds: over.targetIds ?? ["t1"],
    maxDisclosureProfileId: over.maxDisclosureProfileId ?? "internal",
    minLevel: over.minLevel ?? "info",
    ...(over.categories ? { categories: over.categories } : {}),
    ...(over.purposes ? { purposes: over.purposes } : {}),
    enabled: over.enabled ?? true,
    enabledKey: over.enabled === false ? 0 : 1,
    rules: over.rules ?? [],
    createdBy: "me",
    createdAt: 0,
    updatedAt: 0,
    ...(over.maxIntentsPerFact !== undefined ? { maxIntentsPerFact: over.maxIntentsPerFact } : {}),
    ...(over.deletedAt !== undefined ? { deletedAt: over.deletedAt } : {}),
  }
}

function plan(over: Partial<PlannerInput> = {}): ReturnType<typeof planNotification> {
  return planNotification({
    fact: over.fact ?? fact(),
    subscriptions: over.subscriptions ?? [sub()],
    targets: over.targets ?? new Map([["t1", target()]]),
    incidents: over.incidents ?? [],
    priorIntents: over.priorIntents ?? [],
    policy: over.policy ?? policy(),
    now: over.now ?? 1_000_000,
  })
}

describe("planNotification — A. expiry", () => {
  it("short-circuits to expired when validUntil passed", () => {
    const d = plan({ fact: fact({ validUntil: 500 }) })
    expect(d.outcome).toBe("expired")
    expect(d.routes[0].reasonCode).toBe("expires-at-past")
  })
})

describe("planNotification — B. subscription match", () => {
  it("is not-subscribed when no subscription binds", () => {
    const d = plan({ subscriptions: [sub({ binding: { kind: "run", runId: "other" } })] })
    expect(d.outcome).toBe("not-subscribed")
    expect(d.routes[0].reasonCode).toBe("route-missing")
  })

  it("binds a run-scoped subscription to its run", () => {
    const d = plan({
      fact: fact({ runId: "r1" }),
      subscriptions: [sub({ binding: { kind: "run", runId: "r1" } })],
    })
    expect(d.outcome).toBe("notified")
  })

  it("is not-subscribed when the route is disabled", () => {
    const d = plan({ subscriptions: [sub({ enabled: false })] })
    expect(d.routes[0].reasonCode).toBe("route-disabled")
  })

  it("is not-subscribed below the route's min level", () => {
    const d = plan({ subscriptions: [sub({ minLevel: "error" })], fact: fact({ level: "info" }) })
    expect(d.routes[0].reasonCode).toBe("below-min-level")
  })

  it("is not-subscribed when the category isn't served", () => {
    const d = plan({
      subscriptions: [sub({ categories: ["incident"] })],
      fact: fact({ category: "run.terminal" }),
    })
    expect(d.routes[0].reasonCode).toBe("category-not-served")
  })

  it("is not-subscribed on principal mismatch", () => {
    const d = plan({
      subscriptions: [sub({ principalId: "acct" })],
      fact: fact({ principalId: "someone-else" }),
    })
    expect(d.routes[0].reasonCode).toBe("principal-mismatch")
  })
})

describe("planNotification — C. target", () => {
  it("denies a missing target row", () => {
    const d = plan({ targets: new Map() })
    expect(d.routes[0].kind).toBe("denied-by-target")
    expect(d.routes[0].reasonCode).toBe("target-disabled")
  })

  it("denies a soft-deleted target", () => {
    const d = plan({ targets: new Map([["t1", target({ deletedAt: 1 })]]) })
    expect(d.routes[0].reasonCode).toBe("target-deleted")
  })

  it("denies a disabled target", () => {
    const d = plan({ targets: new Map([["t1", target({ enabled: false })]]) })
    expect(d.routes[0].reasonCode).toBe("target-disabled")
  })

  it("denies an origin-reply target for a non-approval fact", () => {
    const d = plan({
      targets: new Map([
        [
          "t1",
          target({
            consent: { mode: "origin-reply", grantRef: "g", grantedBy: "m", grantedAt: 0 },
          }),
        ],
      ]),
      fact: fact({ purpose: "terminal-state" }),
    })
    expect(d.routes[0].reasonCode).toBe("consent-mode-origin-only")
  })

  it("allows an origin-reply target for an approval-request", () => {
    const d = plan({
      targets: new Map([
        [
          "t1",
          target({
            consent: { mode: "origin-reply", grantRef: "g", grantedBy: "m", grantedAt: 0 },
          }),
        ],
      ]),
      fact: fact({ purpose: "approval-request", category: "approval.request" }),
    })
    expect(d.routes[0].kind).toBe("notified")
  })
})

describe("planNotification — D. route rules", () => {
  it("a deny rule wins over everything", () => {
    const d = plan({ subscriptions: [sub({ rules: [{ kind: "deny" }] })] })
    expect(d.routes[0].kind).toBe("denied-by-policy")
    expect(d.routes[0].reasonCode).toBe("policy-rule-deny")
  })

  it("a defer rule postpones to its until", () => {
    const d = plan({ subscriptions: [sub({ rules: [{ kind: "defer", until: 5_000_000 }] })] })
    expect(d.routes[0].kind).toBe("deferred")
    expect(d.routes[0].reasonCode).toBe("explicit-defer-rule")
    expect(d.routes[0].deferredUntil).toBe(5_000_000)
  })

  it("an aggregate rule folds into a digest bucket", () => {
    const d = plan({ subscriptions: [sub({ rules: [{ kind: "aggregate" }] })] })
    expect(d.routes[0].kind).toBe("digest")
    expect(d.routes[0].reasonCode).toBe("aggregated-into-bucket")
    expect(d.routes[0].aggregateKey).toBeTruthy()
  })

  it("a scoped deny rule only fires when its match applies", () => {
    const d = plan({
      subscriptions: [sub({ rules: [{ kind: "deny", match: { categories: ["incident"] } }] })],
      fact: fact({ category: "run.terminal" }),
    })
    expect(d.routes[0].kind).toBe("notified")
  })

  it("suppress-if-unchanged suppresses an already-accepted identical fact", () => {
    const accepted: NotificationDeliveryIntent = {
      id: "p",
      scopeKey: "s",
      scope: SCOPE,
      operationKey: "op",
      targetId: "t1",
      targetAddress: { kind: "feishu-webhook", endpointSecretRef: "x", region: "feishu" },
      targetVersion: 1,
      purpose: "terminal-state",
      category: "run.terminal",
      status: "accepted",
      payload: {
        title: "t",
        body: "b",
        level: "info",
        disclosureLevel: "internal",
        clippedFactCount: 0,
        contentHash: "MH",
      },
      attemptCount: 0,
      maxAttempts: 3,
      createdAt: 0,
      updatedAt: 0,
    }
    const d = plan({
      subscriptions: [sub({ rules: [{ kind: "suppress-if-unchanged" }] })],
      fact: fact({ materialHash: "MH" }),
      priorIntents: [accepted],
    })
    expect(d.routes[0].kind).toBe("suppressed")
    expect(d.routes[0].reasonCode).toBe("materially-unchanged")
  })
})

describe("planNotification — E. quiet hours", () => {
  it("defers into the target's release instant during quiet hours", () => {
    // now inside the 22:00→08:00 UTC window (e.g. 23:30 UTC).
    const now = Date.parse("2026-03-10T23:30:00Z")
    const d = plan({
      policy: policy({ quietHoursEnabled: true, quietHoursStart: "22:00", quietHoursEnd: "08:00" }),
      now,
    })
    expect(d.routes[0].kind).toBe("deferred")
    expect(d.routes[0].reasonCode).toBe("quiet-hours")
    expect(d.routes[0].deferredUntil).toBeGreaterThan(now)
  })
})

describe("planNotification — F. suppression + duplicate", () => {
  it("suppresses a fact folded into an open incident (not the root)", () => {
    const d = plan({
      fact: fact({ factKey: "run:r1:step-failed" }),
      incidents: [
        {
          id: "inc1",
          scopeKey: "s",
          factKey: "inc1",
          stateKind: "incident",
          incident: {
            rootFactKey: "run:r1:failed",
            memberFactKeys: ["run:r1:step-failed"],
            state: "open",
            openedAt: 0,
          },
          createdAt: 0,
          updatedAt: 0,
        },
      ],
    })
    expect(d.routes[0].kind).toBe("suppressed")
    expect(d.routes[0].reasonCode).toBe("inhibited-by-incident")
  })

  it("does not suppress the incident ROOT fact", () => {
    const d = plan({
      fact: fact({ factKey: "run:r1:failed" }),
      incidents: [
        {
          id: "inc1",
          scopeKey: "s",
          factKey: "inc1",
          stateKind: "incident",
          incident: {
            rootFactKey: "run:r1:failed",
            memberFactKeys: ["run:r1:failed"],
            state: "open",
            openedAt: 0,
          },
          createdAt: 0,
          updatedAt: 0,
        },
      ],
    })
    expect(d.routes[0].kind).toBe("notified")
  })
})

describe("planNotification — G. emit + outcome", () => {
  it("notifies with the resolved disclosure level", () => {
    const d = plan()
    expect(d.routes[0].kind).toBe("notified")
    expect(d.routes[0].reasonCode).toBe("routed")
    expect(d.routes[0].disclosureLevel).toBe("internal")
  })

  it("fans out one route per (subscription, target)", () => {
    const d = plan({
      subscriptions: [sub({ targetIds: ["t1", "t2"] })],
      targets: new Map([
        ["t1", target({ id: "t1" })],
        ["t2", target({ id: "t2" })],
      ]),
    })
    expect(d.routes).toHaveLength(2)
    expect(d.outcome).toBe("notified")
  })

  it("outcome is the best route kind — notified beats deferred", () => {
    const d = plan({
      subscriptions: [
        sub({ id: "a", targetIds: ["t1"], rules: [{ kind: "defer", until: 9_000_000 }] }),
        sub({ id: "b", targetIds: ["t1"] }),
      ],
    })
    expect(d.outcome).toBe("notified")
  })
})

describe("planNotification — B gates: purpose, quota, duplicate", () => {
  it("denies a route whose subscription doesn't serve the fact's purpose", () => {
    const d = plan({
      subscriptions: [sub({ purposes: ["approval-request"] })], // fact is terminal-state
    })
    expect(d.routes[0].kind).toBe("not-subscribed")
    expect(d.routes[0].reasonCode).toBe("purpose-not-served")
  })

  it("denies a route once the subscription's per-fact quota is minted", () => {
    const prior = priorIntent({ subscriptionId: "s1", status: "accepted" })
    const d = plan({
      subscriptions: [sub({ maxIntentsPerFact: 1 })],
      priorIntents: [prior],
    })
    expect(d.routes[0].kind).toBe("denied-by-policy")
    expect(d.routes[0].reasonCode).toBe("quota-exceeded")
  })

  it("marks an already-accepted identical send on the same target a duplicate", () => {
    const prior = priorIntent({
      targetId: "t1",
      status: "accepted",
      contentHash: "mat-1",
    })
    const d = plan({
      fact: fact({ materialHash: "mat-1" }),
      priorIntents: [prior],
    })
    expect(d.routes[0].kind).toBe("duplicate")
    expect(d.routes[0].reasonCode).toBe("same-content-accepted")
  })
})

function priorIntent(
  over: {
    subscriptionId?: string
    targetId?: string
    status?: NotificationDeliveryIntent["status"]
    contentHash?: string
  } = {}
): NotificationDeliveryIntent {
  return {
    id: `ndi-${Math.random()}`,
    scopeKey: "n::acct::",
    scope: SCOPE,
    operationKey: `op-${Math.random()}`,
    targetId: over.targetId ?? "t1",
    targetAddress: { kind: "feishu-webhook", endpointSecretRef: "x", region: "feishu" },
    targetVersion: 1,
    purpose: "terminal-state",
    category: "run.terminal",
    ...(over.subscriptionId ? { subscriptionId: over.subscriptionId } : {}),
    status: over.status ?? "accepted",
    payload: {
      title: "t",
      body: "b",
      level: "info",
      disclosureLevel: "internal",
      clippedFactCount: 0,
      contentHash: over.contentHash ?? "h",
    },
    attemptCount: 0,
    maxAttempts: 5,
    createdAt: 0,
    updatedAt: 0,
  }
}

describe("planNotification — disclosure ceiling (route ∩ target)", () => {
  it("stamps effectiveProfileId = the route ceiling when it's narrower than the target", () => {
    // Subscription caps at `public`; the target is `internal`. The narrowed
    // profile rides the verdict so the render clips at `public`, never the
    // wider target profile.
    const d = plan({
      subscriptions: [sub({ maxDisclosureProfileId: "public" })],
      targets: new Map([["t1", target({ disclosureProfileId: "internal" })]]),
    })
    expect(d.routes[0].kind).toBe("notified")
    expect(d.routes[0].effectiveProfileId).toBe("public")
    expect(d.routes[0].disclosureLevel).toBe("public")
  })

  it("stamps effectiveProfileId = the target ceiling when it's narrower than the route", () => {
    // Route allows `internal`; the target only accepts `public`. Narrower wins.
    const d = plan({
      subscriptions: [sub({ maxDisclosureProfileId: "internal" })],
      targets: new Map([["t1", target({ disclosureProfileId: "public" })]]),
    })
    expect(d.routes[0].effectiveProfileId).toBe("public")
    expect(d.routes[0].disclosureLevel).toBe("public")
  })

  it("stamps effectiveProfileId on deferred and digest routes too", () => {
    const d = plan({
      subscriptions: [
        sub({ maxDisclosureProfileId: "public", rules: [{ kind: "defer", until: 9_000_000 }] }),
      ],
      targets: new Map([["t1", target({ disclosureProfileId: "internal" })]]),
    })
    expect(d.routes[0].kind).toBe("deferred")
    expect(d.routes[0].effectiveProfileId).toBe("public")
  })
})
