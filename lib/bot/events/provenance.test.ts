import type { BotEventEnvelopeV1, BotEventProvenanceV1 } from "@/types/bot/event"

import {
  MAX_BOT_EVENT_DEPTH,
  MAX_CAUSATION_IDS,
  evaluateBotLoopGuard,
  externalProvenance,
  provenanceForBotOutput,
} from "./provenance"

function envelope(provenance: BotEventProvenanceV1): BotEventEnvelopeV1 {
  return {
    eventId: "bev_1",
    deliveryId: "bdl_1",
    source: "integration",
    type: "issue_comment.created",
    installationId: "boti_1",
    triggerId: "t",
    occurredAt: 1,
    receivedAt: 1,
    payload: {},
    provenance,
  }
}

describe("evaluateBotLoopGuard", () => {
  it("allows an ordinary external event", () => {
    expect(
      evaluateBotLoopGuard({ envelope: envelope(externalProvenance()), installationId: "boti_1" })
    ).toEqual({ allowed: true })
  })

  it("refuses an event this installation produced", () => {
    const verdict = evaluateBotLoopGuard({
      envelope: envelope({
        selfProduced: true,
        depth: 1,
        producedByInstallationId: "boti_1",
      }),
      installationId: "boti_1",
    })
    expect(verdict).toEqual({ allowed: false, reason: "self_produced" })
  })

  it("allows an event a DIFFERENT installation produced", () => {
    // Another Bot answering is not this Bot answering itself.
    expect(
      evaluateBotLoopGuard({
        envelope: envelope({
          selfProduced: true,
          depth: 1,
          producedByInstallationId: "boti_2",
        }),
        installationId: "boti_1",
      })
    ).toEqual({ allowed: true })
  })

  it("treats an unattributed self-produced event as this installation's", () => {
    // Failing closed: an event we know we made but cannot attribute is more
    // likely ours than somebody else's.
    expect(
      evaluateBotLoopGuard({
        envelope: envelope({ selfProduced: true, depth: 1 }),
        installationId: "boti_1",
      })
    ).toEqual({ allowed: false, reason: "self_produced" })
  })

  it("honours the self-triggering opt-in", () => {
    expect(
      evaluateBotLoopGuard({
        envelope: envelope({ selfProduced: true, depth: 1, producedByInstallationId: "boti_1" }),
        installationId: "boti_1",
        allowSelfTriggering: true,
      })
    ).toEqual({ allowed: true })
  })

  it("caps depth even with the opt-in on", () => {
    // An opt-in that removes every brake is an opt-in to an unbounded loop,
    // and the person enabling it is not the person who pays for it.
    expect(
      evaluateBotLoopGuard({
        envelope: envelope({ selfProduced: true, depth: MAX_BOT_EVENT_DEPTH }),
        installationId: "boti_1",
        allowSelfTriggering: true,
      })
    ).toEqual({ allowed: false, reason: "depth_exceeded" })
  })

  it("caps depth for an external chain nobody claims", () => {
    // A source that cannot say who produced something still cannot drive an
    // unbounded chain.
    expect(
      evaluateBotLoopGuard({
        envelope: envelope({ selfProduced: false, depth: MAX_BOT_EVENT_DEPTH }),
        installationId: "boti_1",
      })
    ).toEqual({ allowed: false, reason: "depth_exceeded" })
  })

  it("allows the last generation before the cap", () => {
    expect(
      evaluateBotLoopGuard({
        envelope: envelope({ selfProduced: false, depth: MAX_BOT_EVENT_DEPTH - 1 }),
        installationId: "boti_1",
      })
    ).toEqual({ allowed: true })
  })
})

describe("provenanceForBotOutput", () => {
  it("stamps the run and installation that produced it", () => {
    expect(provenanceForBotOutput({ runId: "run_1", installationId: "boti_1" })).toEqual({
      selfProduced: true,
      producedByRunId: "run_1",
      producedByInstallationId: "boti_1",
      depth: 1,
    })
  })

  it("carries the cause's depth forward", () => {
    const produced = provenanceForBotOutput({
      runId: "run_2",
      installationId: "boti_1",
      cause: envelope({ selfProduced: false, depth: 1 }),
    })
    expect(produced.depth).toBe(2)
  })

  it("records the causation chain newest first", () => {
    const produced = provenanceForBotOutput({
      runId: "run_2",
      installationId: "boti_1",
      cause: envelope({
        selfProduced: false,
        depth: 0,
        causationEventIds: ["bev_older"],
      }),
    })
    expect(produced.causationEventIds).toEqual(["bev_1", "bev_older"])
  })

  it("bounds the causation chain so a long one stays readable", () => {
    const produced = provenanceForBotOutput({
      runId: "run_2",
      installationId: "boti_1",
      cause: envelope({
        selfProduced: false,
        depth: 0,
        causationEventIds: Array.from({ length: 20 }, (_, i) => `bev_${i}`),
      }),
    })
    expect(produced.causationEventIds).toHaveLength(MAX_CAUSATION_IDS)
  })

  it("records the brokered action when one produced the output", () => {
    expect(
      provenanceForBotOutput({
        runId: "run_1",
        installationId: "boti_1",
        actionJobId: "job_9",
      }).producedByActionJobId
    ).toBe("job_9")
  })
})
