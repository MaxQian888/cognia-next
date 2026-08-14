import { digestAnthropicRequest } from "@/lib/ai/replay/normalize-anthropic-request"
import { runReplay, canonicalDriver, type ReplayDriverContext } from "./run-replay"

const PAYLOAD = {
  model: "claude-opus-5",
  system: "be helpful",
  messages: [{ role: "user", content: "hello" }],
  max_tokens: 256,
  stream: true,
}

async function digest(): Promise<string> {
  const { requestDigest } = await digestAnthropicRequest(PAYLOAD, {
    provider: "anthropic",
    purpose: "turn",
  })
  return requestDigest
}

function fixture(requestDigest: string, overrides: Record<string, unknown> = {}) {
  return {
    scenario: {
      schemaVersion: 1,
      scenarioId: "sc-1",
      title: "plain turn",
      level: "runtime",
      platform: "headless",
      actors: [{ actorRef: "root", role: "root" }],
      inputSteps: [{ kind: "prompt", actorRef: "root", text: "hello" }],
      permissionScript: [],
      expectations: { assertConsumed: true, fidelity: "full" },
    },
    tapes: [
      {
        schemaVersion: 1,
        tapeId: "tape-1",
        match: { actorRef: "root", purpose: "turn", requestDigest },
        behavior: { kind: "stream", chunksRef: "chunks-1" },
        synthetic: true,
      },
    ],
    assets: { "chunks-1": ["Hello!"] },
    ...overrides,
  }
}

/** Drives the run by making the model call the fixture expects. */
async function callModel(context: ReplayDriverContext): Promise<Record<string, never>> {
  const response = await fetch(`${context.server.baseUrlFor("root")}/v1/messages`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(PAYLOAD),
  })
  await response.text()
  return {}
}

describe("runReplay", () => {
  it("passes when the driver makes exactly the recorded call", async () => {
    const result = await runReplay({ raw: fixture(await digest()), driver: callModel })
    expect(result.ok).toBe(true)
    expect(result.requests).toBe(1)
    expect(result.unmatched).toBe(0)
    expect(result.summary).toContain("consumed every tape")
  })

  it("fails when a recorded call never happens", async () => {
    const result = await runReplay({ raw: fixture(await digest()), driver: canonicalDriver })
    expect(result.ok).toBe(false)
    expect(result.summary).toContain("never requested")
  })

  it("fails when the driver asks something that was not recorded", async () => {
    const result = await runReplay({
      raw: fixture(`sha256:${"0".repeat(64)}`),
      driver: callModel,
    })
    expect(result.ok).toBe(false)
    expect(result.unmatched).toBe(1)
    expect(result.summary).toContain("had no tape")
  })

  it("rejects a fixture with a real recording in it", async () => {
    const raw = fixture(await digest())
    raw.tapes[0].synthetic = false
    const result = await runReplay({ raw, driver: callModel })
    expect(result.ok).toBe(false)
    expect(result.errors?.[0]).toContain("cannot be admitted")
  })

  it("admits a real recording when the operator opts in", async () => {
    const raw = fixture(await digest())
    raw.tapes[0].synthetic = false
    const result = await runReplay({ raw, driver: callModel, requireSynthetic: false })
    expect(result.ok).toBe(true)
  })

  it("refuses runtime replay in a browser and says why", async () => {
    const result = await runReplay({
      raw: fixture(await digest()),
      driver: callModel,
      platform: "browser",
    })
    expect(result.ok).toBe(false)
    expect(result.summary).toContain("desktop app")
  })

  it("still reports unused tapes when the driver throws", async () => {
    const result = await runReplay({
      raw: fixture(await digest()),
      driver: async () => {
        throw new Error("agent crashed")
      },
    })
    expect(result.ok).toBe(false)
    expect(result.summary).toContain("agent crashed")
    expect(result.summary).toContain("never requested")
  })

  it("rejects a fixture whose stream body is missing", async () => {
    const result = await runReplay({
      raw: fixture(await digest(), { assets: {} }),
      driver: callModel,
    })
    expect(result.ok).toBe(false)
    expect(result.errors?.some((error) => error.includes("does not carry"))).toBe(true)
  })
})
