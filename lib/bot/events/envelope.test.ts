import type { BotEventEnvelopeV1 } from "@/types/bot/event"

import {
  botDeliveryId,
  botEventId,
  buildBotEventEnvelope,
  interpolateEnvelopeTemplate,
  oneOffSourceRecordId,
  readEnvelopePath,
} from "./envelope"

const NOW = 1_700_000_000_000

function envelope(): BotEventEnvelopeV1 {
  return buildBotEventEnvelope({
    source: "integration",
    sourceRecordId: "delivery-7",
    type: "pull_request.opened",
    installationId: "boti_1",
    triggerId: "opened",
    occurredAt: NOW,
    receivedAt: NOW,
    payload: { number: 42, title: "Fix the thing" },
    resource: { kind: "pull_request", id: "42", scope: "acme/web" },
  })
}

describe("botEventId", () => {
  it("is deterministic, so a redelivered webhook is the same event", () => {
    expect(botEventId("integration", "delivery-7")).toBe(botEventId("integration", "delivery-7"))
  })

  it("separates the same record id arriving from two sources", () => {
    expect(botEventId("integration", "7")).not.toBe(botEventId("connector", "7"))
  })
})

describe("botDeliveryId", () => {
  it("is per recipient, so a fan-out produces distinct rows", () => {
    expect(botDeliveryId("bev_1", "boti_1")).not.toBe(botDeliveryId("bev_1", "boti_2"))
  })
})

describe("oneOffSourceRecordId", () => {
  it("is unique per call, for a source with no id of its own", () => {
    expect(oneOffSourceRecordId("manual")).not.toBe(oneOffSourceRecordId("manual"))
    expect(oneOffSourceRecordId("manual")).toMatch(/^manual_/)
  })
})

describe("buildBotEventEnvelope", () => {
  it("defaults provenance to a first-party external event", () => {
    expect(envelope().provenance).toEqual({ selfProduced: false, depth: 0 })
  })

  it("omits absent optional fields rather than storing undefined", () => {
    const built = envelope()
    expect("actor" in built).toBe(false)
    expect("correlation" in built).toBe(false)
    expect("sequence" in built).toBe(false)
  })

  it("carries a supplied provenance through", () => {
    const built = buildBotEventEnvelope({
      source: "integration",
      sourceRecordId: "d1",
      type: "issue_comment.created",
      installationId: "boti_1",
      triggerId: "t",
      occurredAt: NOW,
      payload: {},
      provenance: { selfProduced: true, depth: 2, producedByRunId: "run_1" },
    })
    expect(built.provenance).toEqual({
      selfProduced: true,
      depth: 2,
      producedByRunId: "run_1",
    })
  })

  it("keeps a zero sequence, which is a real ordering position", () => {
    const built = buildBotEventEnvelope({
      source: "connector",
      sourceRecordId: "d1",
      type: "message",
      installationId: "boti_1",
      triggerId: "t",
      occurredAt: NOW,
      payload: {},
      sequence: 0,
    })
    expect(built.sequence).toBe(0)
  })
})

describe("readEnvelopePath", () => {
  it("reads a nested own property", () => {
    expect(readEnvelopePath(envelope(), "resource.id")).toBe("42")
    expect(readEnvelopePath(envelope(), "payload.title")).toBe("Fix the thing")
  })

  it("misses rather than reaching through the prototype", () => {
    // The payload is written by whoever opened the pull request.
    expect(readEnvelopePath(envelope(), "__proto__.constructor")).toBeUndefined()
    expect(readEnvelopePath(envelope(), "payload.constructor")).toBeUndefined()
    expect(readEnvelopePath(envelope(), "payload.toString")).toBeUndefined()
  })

  it("misses on an absent path and on an empty one", () => {
    expect(readEnvelopePath(envelope(), "resource.nope")).toBeUndefined()
    expect(readEnvelopePath(envelope(), "")).toBeUndefined()
  })
})

describe("interpolateEnvelopeTemplate", () => {
  it("substitutes a dotted path", () => {
    expect(interpolateEnvelopeTemplate("repo:{{resource.scope}}#{{resource.id}}", envelope())).toBe(
      "repo:acme/web#42"
    )
  })

  it("tolerates whitespace inside the braces", () => {
    expect(interpolateEnvelopeTemplate("{{ resource.id }}", envelope())).toBe("42")
  })

  it("empties an unresolved placeholder instead of leaving the literal", () => {
    // A key still containing `{{resource.id}}` would serialise every delivery
    // of that trigger against every other one, which reads as a hang.
    expect(interpolateEnvelopeTemplate("k:{{resource.missing}}", envelope())).toBe("k:")
  })

  it("empties an object-valued placeholder", () => {
    expect(interpolateEnvelopeTemplate("k:{{payload}}", envelope())).toBe("k:")
  })

  it("leaves a template with no placeholders alone", () => {
    expect(interpolateEnvelopeTemplate("constant", envelope())).toBe("constant")
  })
})
