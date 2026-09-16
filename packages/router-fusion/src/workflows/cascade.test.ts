import { RunResultSchema } from "../contracts/schemas"
import { FakeProvider, type FakeScript, type FakeStep } from "../fake/fake-provider"
import { MemoryArtifactStore } from "../fake/memory-artifacts"
import { MemoryCallLedger } from "../fake/memory-ledger"
import { SPEC_MOCK_REGISTRY } from "../fake/mock-registry"
import {
  failureReportText,
  runCascade,
  type CascadeRunInput,
  type CascadeRunPorts,
} from "./cascade"
import { PolicyRefusalError } from "./durable-call"
import type { WorkflowEvent } from "./ports"

const SCHEMA = {
  type: "object",
  required: ["total"],
  properties: { total: { type: "number" } },
  additionalProperties: false,
}

/** Answer by role: each role plays its own steps in order. */
function byRole(steps: Record<string, FakeStep[]>): FakeScript {
  const seen: Record<string, number> = {}
  return (request) => {
    const list = steps[request.role] ?? [{ kind: "text", text: `unscripted ${request.role}` }]
    const index = seen[request.role] ?? 0
    seen[request.role] = index + 1
    return list[Math.min(index, list.length - 1)]
  }
}

function setup(script: FakeScript, cap = 1_000_000) {
  const ledger = new MemoryCallLedger({
    capMicrousd: cap,
    maxModelCalls: 24,
    deployments: Object.fromEntries(SPEC_MOCK_REGISTRY.deployments.map((d) => [d.id, d])),
    rateCards: Object.fromEntries(SPEC_MOCK_REGISTRY.rate_cards.map((c) => [c.id, c])),
  })
  const provider = new FakeProvider(script)
  const events: WorkflowEvent[] = []
  let id = 0
  const ports: CascadeRunPorts = {
    ledger,
    executor: provider,
    events: { emit: async (event) => void events.push(event) },
    clock: { now: () => 0 },
    sleep: async () => undefined,
    artifacts: new MemoryArtifactStore(),
    newId: () => `77777777-7777-4777-8777-${String(++id).padStart(12, "0")}`,
  }
  return { ports, provider, ledger, events }
}

function input(overrides: Partial<CascadeRunInput> = {}): CascadeRunInput {
  return {
    runId: "run-1",
    cheapDeploymentId: "fake-economy",
    strongDeploymentId: "fake-baseline",
    messages: [{ role: "user", content: "Add up the invoice lines and return the total." }],
    maxOutputTokens: 512,
    reserveMicrousd: { cheap: 5_000, strong: 20_000, reviewer: 20_000 },
    transportAttempts: 2,
    maxFormatRepairs: 1,
    deadlineAt: 1_000_000,
    profile: "schema_fixture",
    task: "data.extract",
    deliversChange: false,
    allowDegraded: false,
    jsonSchema: SCHEMA,
    fixtureExpectations: { total: 42 },
    signal: new AbortController().signal,
    ...overrides,
  }
}

describe("runCascade", () => {
  it("[ACC:CAS-01] finishes on a cheap answer that passes, without calling the strong model", async () => {
    const { ports, provider, ledger } = setup(
      byRole({ cheap: [{ kind: "json", value: { total: 42 } }] })
    )
    const outcome = await runCascade(ports, input())

    expect(provider.requests.map((request) => request.role)).toEqual(["cheap"])
    expect(provider.requests[0].deploymentId).toBe("fake-economy")
    expect(outcome.escalated).toBe(false)
    expect(outcome.result).toMatchObject({
      mode_executed: "cascade",
      quality_status: "accepted",
      verification: { status: "passed", level: "tool_verified" },
    })
    expect(RunResultSchema.parse(outcome.result)).toEqual(outcome.result)
    expect(ledger.state.modelCalls).toBe(1)
  })

  it("[ACC:CAS-02] escalates once on a failed check, with the failure report and both bills", async () => {
    const { ports, provider, ledger, events } = setup(
      byRole({
        cheap: [{ kind: "json", value: { total: 41 } }],
        strong: [{ kind: "json", value: { total: 42 } }],
      })
    )
    const outcome = await runCascade(ports, input())

    expect(provider.requests.map((request) => request.role)).toEqual(["cheap", "strong"])
    expect(outcome).toMatchObject({ escalated: true, escalationReason: "VERIFICATION_FAILED" })
    expect(outcome.reports.cheap?.status).toBe("failed")
    expect(outcome.reports.strong?.status).toBe("passed")
    expect(outcome.result.quality_status).toBe("accepted")
    expect(outcome.result.warnings).toContain("escalated:VERIFICATION_FAILED")

    // The escalation is traceable: a rejection with its report, then the reason.
    const rejected = events.find((event) => event.type === "candidate.rejected")
    expect(rejected?.payload).toMatchObject({
      stage: "cheap",
      reason: "VERIFICATION_FAILED",
      report_id: outcome.reports.cheap?.report_id,
    })
    expect(events.some((event) => event.payload.step === "escalate")).toBe(true)

    // Both calls were billed as themselves.
    expect(ledger.attempts.map((attempt) => [attempt.role, attempt.state])).toEqual([
      ["cheap", "SUCCEEDED"],
      ["strong", "SUCCEEDED"],
    ])
    expect(ledger.attempts.every((attempt) => (attempt.actualMicrousd ?? 0) > 0)).toBe(true)
    expect(ledger.totalSettledMicrousd()).toBe(
      ledger.attempts.reduce((sum, attempt) => sum + (attempt.actualMicrousd ?? 0), 0)
    )
  })

  it("gives the strong model the failure report, not the cheap model's draft", async () => {
    const { ports, provider } = setup(
      byRole({
        cheap: [{ kind: "json", value: { total: 999_999 } }],
        strong: [{ kind: "json", value: { total: 42 } }],
      })
    )
    await runCascade(ports, input())
    const strongRequest = provider.requests[1]
    const transcript = strongRequest.messages.map((message) => message.content).join("\n")
    expect(transcript).not.toContain("999999")
    expect(transcript).toContain("VERIFICATION_FAILED")
    expect(transcript).toContain('<untrusted-data label="the objective failure report">')
    expect(strongRequest.messages[0]).toEqual(input().messages[0])
    expect(strongRequest.logicalStepId).toBe("cascade:strong")
  })

  it("[ACC:CAS-03] never returns accepted when both stages are inconclusive", async () => {
    // No fixture expectations and no schema: schema_fixture can only be inconclusive.
    const script = byRole({
      cheap: [{ kind: "text", text: "a" }],
      strong: [{ kind: "text", text: "b" }],
    })
    const refused = setup(script)
    await expect(
      runCascade(refused.ports, input({ jsonSchema: undefined, fixtureExpectations: undefined }))
    ).rejects.toMatchObject({ code: "VERIFICATION_INCONCLUSIVE" })
    expect(refused.provider.requests.map((request) => request.role)).toEqual(["cheap", "strong"])

    const allowed = setup(
      byRole({ cheap: [{ kind: "text", text: "a" }], strong: [{ kind: "text", text: "b" }] })
    )
    const degraded = await runCascade(
      allowed.ports,
      input({ jsonSchema: undefined, fixtureExpectations: undefined, allowDegraded: true })
    )
    expect(degraded.result.quality_status).toBe("degraded")
    expect(degraded.result.quality_status).not.toBe("accepted")
    expect(degraded.result.warnings).toContain("verification_inconclusive")
    expect(degraded.escalationReason).toBe("VERIFICATION_INCONCLUSIVE")
  })

  it("[ACC:CAS-04] stops at a policy refusal instead of asking the strong model", async () => {
    const { ports, provider, ledger } = setup(
      byRole({
        cheap: [{ kind: "refusal", message: "content policy" }],
        strong: [{ kind: "json", value: { total: 42 } }],
      })
    )
    await expect(runCascade(ports, input())).rejects.toBeInstanceOf(PolicyRefusalError)
    expect(provider.requests.map((request) => request.role)).toEqual(["cheap"])
    // The refusal is still a billed attempt.
    expect(ledger.attempts[0]).toMatchObject({ role: "cheap", state: "FAILED" })
  })

  it("does not escalate on a transient failure, which the same call retries", async () => {
    const { ports, provider } = setup(
      byRole({ cheap: [{ kind: "rate_limited" }, { kind: "json", value: { total: 42 } }] })
    )
    const outcome = await runCascade(ports, input())
    expect(outcome.escalated).toBe(false)
    expect(provider.requests.map((request) => request.logicalStepId)).toEqual([
      "cascade:cheap",
      "cascade:cheap",
    ])
  })

  it("escalates structured output that stayed invalid, sharing one repair across the run", async () => {
    const { ports, provider } = setup(
      byRole({
        cheap: [{ kind: "invalid_json" }, { kind: "invalid_json" }],
        strong: [{ kind: "json", value: { total: 42 } }],
      })
    )
    const outcome = await runCascade(ports, input())
    expect(outcome).toMatchObject({
      escalated: true,
      escalationReason: "FORMAT_INVALID",
      formatRepairs: 1,
    })
    expect(provider.requests.map((request) => request.logicalStepId)).toEqual([
      "cascade:cheap",
      "cascade:cheap:format_repair:1",
      "cascade:strong",
    ])

    // The repair was spent: an invalid strong answer now fails the run.
    const spent = setup(
      byRole({
        cheap: [{ kind: "invalid_json" }, { kind: "invalid_json" }],
        strong: [{ kind: "invalid_json" }],
      })
    )
    await expect(runCascade(spent.ports, input())).rejects.toMatchObject({ code: "FORMAT_INVALID" })
  })

  it("fails a run whose escalated answer also fails, without a third attempt", async () => {
    const { ports, provider } = setup(
      byRole({
        cheap: [{ kind: "json", value: { total: 1 } }],
        strong: [{ kind: "json", value: { total: 2 } }],
      })
    )
    await expect(runCascade(ports, input())).rejects.toMatchObject({
      code: "VERIFICATION_FAILED",
      details: { escalation_reason: "VERIFICATION_FAILED" },
    })
    expect(provider.requests).toHaveLength(2)
  })

  it("reviews each stage under text_review, with the reviewer the action names", async () => {
    const { ports, provider } = setup(
      byRole({
        cheap: [{ kind: "text", text: "a thin answer" }],
        strong: [{ kind: "text", text: "a full answer" }],
        reviewer: [
          { kind: "json", value: { status: "failed", issues: ["misses the total"] } },
          { kind: "json", value: { status: "passed", issues: [] } },
        ],
      })
    )
    const outcome = await runCascade(
      ports,
      input({
        profile: "text_review",
        task: "qa.knowledge",
        jsonSchema: undefined,
        fixtureExpectations: undefined,
        reviewerDeploymentId: "fake-independent",
      })
    )
    expect(outcome.result).toMatchObject({ quality_status: "accepted", answer: "a full answer" })
    expect(
      provider.requests.map((request) => [request.logicalStepId, request.deploymentId])
    ).toEqual([
      ["cascade:cheap", "fake-economy"],
      ["cascade:cheap:reviewer", "fake-independent"],
      ["cascade:strong", "fake-baseline"],
      ["cascade:strong:reviewer", "fake-independent"],
    ])
  })

  it("never streams a draft that may still be replaced", async () => {
    const { ports, provider } = setup(
      byRole({
        cheap: [{ kind: "json", value: { total: 1 } }],
        strong: [{ kind: "json", value: { total: 42 } }],
      })
    )
    await runCascade(ports, input())
    expect(provider.requests.every((request) => request.onDelta === undefined)).toBe(true)
  })

  it("replays a crashed cascade from its committed stages", async () => {
    const script = byRole({
      cheap: [{ kind: "json", value: { total: 1 } }],
      strong: [{ kind: "json", value: { total: 42 } }],
    })
    const { ports, provider } = setup(script)
    await runCascade(ports, input())
    const calls = provider.requests.length
    // Same ledger, same graph: every step is already committed.
    const again = await runCascade(ports, input())
    expect(provider.requests).toHaveLength(calls)
    expect(again.result.answer).toBe('{"total":42}')
  })
})

describe("failureReportText", () => {
  it("lists only what did not pass, with the report it came from", () => {
    const text = failureReportText(
      {
        schema_version: "1.0.0",
        report_id: "88888888-8888-4888-8888-888888888888",
        status: "failed",
        level: "tool_verified",
        checks: [
          {
            check_id: "non_empty",
            kind: "format",
            status: "passed",
            summary: "ok",
            executed_by: "runtime",
            artifact_refs: [],
          },
          {
            check_id: "field:total",
            kind: "fixture",
            status: "failed",
            summary: "expected 42",
            executed_by: "runtime",
            artifact_refs: [],
          },
        ],
        revision: null,
        verifier_version: "v",
        artifact_refs: [],
      },
      "VERIFICATION_FAILED"
    )
    expect(text).toBe(
      "VERIFICATION_FAILED (tool_verified, report 88888888-8888-4888-8888-888888888888)\nfield:total (fixture): failed — expected 42"
    )
    expect(failureReportText(null, "FORMAT_INVALID")).toContain("did not match the required schema")
  })
})
