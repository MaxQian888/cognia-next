import type { BotEventEnvelopeV1 } from "@/types/bot/event"
import type { PluginBotTriggerDef } from "@/types/plugin/plugin-bot"

import { MAX_BOT_EVENT_DEPTH } from "./provenance"
import { routeBotEvent, triggerMatches, type BotTriggerBinding } from "./router"

const NOW = 1_700_000_000_000

type RoutableEnvelope = Omit<BotEventEnvelopeV1, "installationId" | "triggerId" | "deliveryId">

function envelope(overrides: Partial<RoutableEnvelope> = {}): RoutableEnvelope {
  return {
    eventId: "bev_1",
    source: "integration",
    type: "pull_request.opened",
    occurredAt: NOW,
    receivedAt: NOW,
    payload: {},
    provenance: { selfProduced: false, depth: 0 },
    resource: { kind: "pull_request", id: "42", scope: "acme/web" },
    ...overrides,
  }
}

function binding(
  trigger: PluginBotTriggerDef,
  overrides: Partial<BotTriggerBinding> = {}
): BotTriggerBinding {
  return { installationId: "boti_1", trigger, ...overrides }
}

const OPENED: PluginBotTriggerDef = {
  id: "opened",
  kind: "event",
  source: "integration",
  types: ["pull_request.opened"],
}

describe("triggerMatches", () => {
  it("matches an event trigger on source and type", () => {
    expect(
      triggerMatches(binding(OPENED), { source: "integration", type: "pull_request.opened" })
    ).toBe(true)
    expect(triggerMatches(binding(OPENED), { source: "integration", type: "issues.opened" })).toBe(
      false
    )
    expect(
      triggerMatches(binding(OPENED), { source: "connector", type: "pull_request.opened" })
    ).toBe(false)
  })

  it("matches an interaction trigger on connector inbound", () => {
    const trigger: PluginBotTriggerDef = { id: "ask", kind: "interaction" }
    expect(triggerMatches(binding(trigger), { source: "connector", type: "message" })).toBe(true)
    expect(triggerMatches(binding(trigger), { source: "integration", type: "message" })).toBe(false)
  })

  it("narrows an interaction trigger to the adapter types it names", () => {
    const trigger: PluginBotTriggerDef = { id: "ask", kind: "interaction", adapterTypes: ["lark"] }
    expect(
      triggerMatches(binding(trigger), { source: "connector", type: "message", adapterId: "lark" })
    ).toBe(true)
    expect(
      triggerMatches(binding(trigger), { source: "connector", type: "message", adapterId: "slack" })
    ).toBe(false)
    // No adapter on the event cannot satisfy a trigger that names some.
    expect(triggerMatches(binding(trigger), { source: "connector", type: "message" })).toBe(false)
  })

  it("never matches a trigger its own producer fires", () => {
    // A schedule is fired BY the scheduler. Matching it from an inbound event
    // would run it once per unrelated event that happened to arrive.
    for (const kind of ["schedule", "poll", "derivedState"] as const) {
      const trigger = { id: "t", kind, cron: "* * * * *", everyMs: 1000, state: "s" } as never
      expect(triggerMatches(binding(trigger), { source: "integration", type: "x" })).toBe(false)
    }
  })

  it("respects the installation's own account binding", () => {
    const bound = binding(OPENED, { integrationAccountId: "acct_a" })
    expect(
      triggerMatches(bound, {
        source: "integration",
        type: "pull_request.opened",
        integrationAccountId: "acct_b",
      })
    ).toBe(false)
    expect(
      triggerMatches(bound, {
        source: "integration",
        type: "pull_request.opened",
        integrationAccountId: "acct_a",
      })
    ).toBe(true)
  })
})

describe("routeBotEvent", () => {
  const query = { source: "integration" as const, type: "pull_request.opened" }

  it("returns nothing when no binding matches", () => {
    expect(routeBotEvent({ envelope: envelope(), bindings: [], query, now: NOW })).toEqual({
      deliveries: [],
      rejected: [],
    })
  })

  it("fans one event out to every matching installation", () => {
    const result = routeBotEvent({
      envelope: envelope(),
      bindings: [
        binding(OPENED),
        binding(OPENED, { installationId: "boti_2" }),
        binding({ id: "other", kind: "event", source: "integration", types: ["issues.opened"] }),
      ],
      query,
      now: NOW,
    })

    expect(result.deliveries.map((d) => d.installationId)).toEqual(["boti_1", "boti_2"])
    // A delivery id is per recipient, so the fan-out produces distinct rows.
    expect(new Set(result.deliveries.map((d) => d.envelope.deliveryId)).size).toBe(2)
  })

  it("stamps the installation and trigger onto each envelope", () => {
    const [delivery] = routeBotEvent({
      envelope: envelope(),
      bindings: [binding(OPENED)],
      query,
      now: NOW,
    }).deliveries

    expect(delivery.envelope.installationId).toBe("boti_1")
    expect(delivery.envelope.triggerId).toBe("opened")
  })

  it("interpolates the concurrency key against the envelope", () => {
    const [delivery] = routeBotEvent({
      envelope: envelope(),
      bindings: [binding({ ...OPENED, concurrencyKey: "{{resource.scope}}#{{resource.id}}" })],
      query,
      now: NOW,
    }).deliveries

    // Scoped to the installation too, or two Bots watching one repo would
    // serialise against each other.
    expect(delivery.concurrencyKey).toBe("boti_1::acme/web#42")
  })

  it("holds a debounced delivery", () => {
    const [delivery] = routeBotEvent({
      envelope: envelope(),
      bindings: [binding({ ...OPENED, debounceMs: 5_000 })],
      query,
      now: NOW,
    }).deliveries

    expect(delivery.notBefore).toBe(NOW + 5_000)
  })

  it("does not hold a delivery for a zero debounce", () => {
    const [delivery] = routeBotEvent({
      envelope: envelope(),
      bindings: [binding({ ...OPENED, debounceMs: 0 })],
      query,
      now: NOW,
    }).deliveries

    expect("notBefore" in delivery).toBe(false)
  })

  it("reports a loop-guard refusal rather than dropping it silently", () => {
    const result = routeBotEvent({
      envelope: envelope({
        provenance: { selfProduced: true, depth: 1, producedByInstallationId: "boti_1" },
      }),
      bindings: [binding(OPENED)],
      query,
      now: NOW,
    })

    // "The Bot ignored my comment" and "the Bot refused to answer itself" look
    // identical from outside, and only one of them is a bug.
    expect(result.deliveries).toEqual([])
    expect(result.rejected).toEqual([
      { installationId: "boti_1", triggerId: "opened", reason: "self_produced" },
    ])
  })

  it("lets the installation's ceiling opt in to self-triggering", () => {
    const result = routeBotEvent({
      envelope: envelope({
        provenance: { selfProduced: true, depth: 1, producedByInstallationId: "boti_1" },
      }),
      bindings: [binding(OPENED, { policy: { allowSelfTriggering: true } })],
      query,
      now: NOW,
    })

    expect(result.deliveries).toHaveLength(1)
  })

  it("refuses a chain past the depth cap regardless of the opt-in", () => {
    const result = routeBotEvent({
      envelope: envelope({
        provenance: { selfProduced: true, depth: MAX_BOT_EVENT_DEPTH },
      }),
      bindings: [binding(OPENED, { policy: { allowSelfTriggering: true } })],
      query,
      now: NOW,
    })

    expect(result.rejected[0].reason).toBe("depth_exceeded")
  })

  it("routes one installation's two matching triggers as two deliveries", () => {
    const result = routeBotEvent({
      envelope: envelope(),
      bindings: [binding(OPENED), binding({ ...OPENED, id: "also-opened" })],
      query,
      now: NOW,
    })

    expect(result.deliveries.map((d) => d.triggerId)).toEqual(["opened", "also-opened"])
  })
})
