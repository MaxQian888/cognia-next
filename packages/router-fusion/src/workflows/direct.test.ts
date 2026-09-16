import { RunResultSchema } from "../contracts/schemas"
import { SPEC_MOCK_REGISTRY } from "../fake/mock-registry"
import { FakeProvider, sequenceScript, type FakeStep } from "../fake/fake-provider"
import { MemoryArtifactStore } from "../fake/memory-artifacts"
import { MemoryCallLedger } from "../fake/memory-ledger"
import type { DirectRunInput, DirectRunPorts } from "./direct"
import { runDirect } from "./direct"
import type { WorkflowEvent } from "./ports"

const SCHEMA = {
  type: "object",
  required: ["title"],
  properties: { title: { type: "string" } },
  additionalProperties: false,
}

function setup(steps: FakeStep[], maxModelCalls = 24) {
  const ledger = new MemoryCallLedger({
    capMicrousd: 1_000_000,
    maxModelCalls,
    deployments: Object.fromEntries(SPEC_MOCK_REGISTRY.deployments.map((d) => [d.id, d])),
    rateCards: Object.fromEntries(SPEC_MOCK_REGISTRY.rate_cards.map((c) => [c.id, c])),
  })
  const provider = new FakeProvider(sequenceScript(steps))
  const events: WorkflowEvent[] = []
  let id = 0
  const ports: DirectRunPorts = {
    ledger,
    executor: provider,
    events: { emit: async (event) => void events.push(event) },
    clock: { now: () => 0 },
    sleep: async () => undefined,
    artifacts: new MemoryArtifactStore(),
    newId: () => `44444444-4444-4444-8444-${String(++id).padStart(12, "0")}`,
  }
  return { ledger, provider, events, ports }
}

function input(overrides: Partial<DirectRunInput> = {}): DirectRunInput {
  return {
    runId: "run-1",
    deploymentId: "fake-baseline",
    messages: [{ role: "user", content: "Summarize the release notes." }],
    maxOutputTokens: 512,
    reserveMicrousd: 20_000,
    transportAttempts: 2,
    maxFormatRepairs: 1,
    deadlineAt: 1_000_000,
    profile: "text_basic",
    task: "text.transform",
    deliversChange: false,
    toolPolicyId: null,
    stream: true,
    signal: new AbortController().signal,
    ...overrides,
  }
}

describe("runDirect", () => {
  it("streams, verifies at schema_only and claims no more than the checks proved", async () => {
    const deltas: string[] = []
    const { ports } = setup([{ kind: "text", text: "Three fixes and one feature." }])
    const { result } = await runDirect(ports, input({ onDelta: (t) => deltas.push(t) }))
    expect(deltas).toEqual(["Three fixes and one feature."])
    expect(result.quality_status).toBe("accepted")
    expect(result.verification.level).toBe("schema_only")
    expect(result.warnings).toContain("verified_format_only")
    expect(RunResultSchema.parse(result)).toEqual(result)
  })

  it("repairs invalid structured output once and labels the replacement", async () => {
    const { ports, events, ledger } = setup([
      { kind: "invalid_json" },
      { kind: "json", value: { title: "ok" } },
    ])
    const outcome = await runDirect(
      ports,
      input({ jsonSchema: SCHEMA, profile: "schema_fixture", task: "data.extract" })
    )
    expect(outcome.formatRepairs).toBe(1)
    expect(outcome.result.verification.status).toBe("passed")
    expect(outcome.result.warnings).toContain("format_repaired")
    expect(events.some((e) => e.payload.step === "answer.replaced")).toBe(true)
    // The repair is a real, billed model call.
    expect(ledger.state.modelCalls).toBe(2)
  })

  it("fails after the single allowed repair instead of looping", async () => {
    const { ports, ledger } = setup([
      { kind: "invalid_json" },
      { kind: "invalid_json" },
      { kind: "json", value: { title: "late" } },
    ])
    await expect(
      runDirect(ports, input({ jsonSchema: SCHEMA, profile: "schema_fixture" }))
    ).rejects.toMatchObject({ code: "FORMAT_INVALID" })
    expect(ledger.state.modelCalls).toBe(2)
  })

  it("[ACC:PROF-01] never reports a plain chat answer to a code task as accepted", async () => {
    const { ports } = setup([{ kind: "text", text: "Change line 3 to use const." }])
    const { result } = await runDirect(ports, input({ task: "code.debug" }))
    expect(result.verification.status).toBe("passed")
    expect(result.quality_status).toBe("unknown")
  })

  it("runs a billed review call for text_review and trusts only a valid verdict", async () => {
    const { ports, ledger } = setup([
      { kind: "text", text: "An answer." },
      { kind: "json", value: { status: "failed", issues: ["misses the second question"] } },
    ])
    const { result } = await runDirect(ports, input({ profile: "text_review" }))
    expect(result.verification.level).toBe("model_review")
    expect(result.verification.status).toBe("failed")
    expect(result.quality_status).toBe("unknown")
    expect(ledger.attempts.map((a) => a.role)).toEqual(["solver", "reviewer"])

    const garbled = setup([{ kind: "text", text: "An answer." }, { kind: "invalid_json" }])
    const second = await runDirect(garbled.ports, input({ profile: "text_review" }))
    expect(second.result.verification.status).toBe("inconclusive")
  })

  it("fails an empty answer under text_basic", async () => {
    const { ports } = setup([{ kind: "text", text: "   " }])
    const { result } = await runDirect(ports, input())
    expect(result.verification.status).toBe("failed")
    expect(result.quality_status).toBe("unknown")
  })

  it("stops when the global model-call cap is reached", async () => {
    const { ports } = setup([{ kind: "invalid_json" }, { kind: "json", value: { title: "x" } }], 1)
    await expect(
      runDirect(ports, input({ jsonSchema: SCHEMA, profile: "schema_fixture" }))
    ).rejects.toMatchObject({ code: "MAX_MODEL_CALLS" })
  })

  it("marks schema_fixture without a schema as inconclusive", async () => {
    const { ports } = setup([{ kind: "text", text: "{}" }])
    const { result } = await runDirect(ports, input({ profile: "schema_fixture" }))
    expect(result.verification.status).toBe("inconclusive")
  })
})
