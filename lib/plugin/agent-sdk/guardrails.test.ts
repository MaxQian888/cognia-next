import {
  runInputGuardrails,
  runOutputGuardrails,
  createPiiOutputGuardrail,
  PluginGuardrailTripwireError,
} from "./guardrails"
import {
  registerGuardrail,
  __resetGuardrailsForTesting,
} from "@/lib/plugin/registries/guardrail-registry"
import type {
  PluginInputGuardrail,
  PluginOutputGuardrail,
} from "@/types/plugin/plugin-agent-guardrails"

jest.mock("@/lib/twin/ingest/redact", () => ({
  hasNoLeakingPii: (s: string) => !s.includes("@"),
}))

beforeEach(() => __resetGuardrailsForTesting())

const passInput = (id: string): PluginInputGuardrail => ({
  id,
  type: "input",
  run: () => ({ tripwireTriggered: false }),
})
const tripInput = (id: string, message?: string): PluginInputGuardrail => ({
  id,
  type: "input",
  run: () => ({ tripwireTriggered: true, ...(message ? { message } : {}) }),
})
const tripOutput = (id: string): PluginOutputGuardrail => ({
  id,
  type: "output",
  run: () => ({ tripwireTriggered: true, message: "bad output" }),
})

describe("runInputGuardrails", () => {
  it("passes when no guardrail trips", async () => {
    await expect(runInputGuardrails("hi", [passInput("ok")], undefined)).resolves.toBeUndefined()
  })

  it("throws a typed tripwire error on the first trip", async () => {
    await expect(
      runInputGuardrails("hi", [passInput("ok"), tripInput("blocked", "nope")], undefined)
    ).rejects.toMatchObject({
      name: "PluginGuardrailTripwireError",
      stage: "input",
      guardrailId: "blocked",
      message: "nope",
    })
  })

  it("only runs input-typed guardrails", async () => {
    const out = jest.fn()
    await runInputGuardrails(
      "hi",
      [{ id: "o", type: "output", run: out } as PluginOutputGuardrail],
      undefined
    )
    expect(out).not.toHaveBeenCalled()
  })

  it("resolves registered guardrails by id string", async () => {
    registerGuardrail("reg", tripInput("reg", "registered trip"))
    await expect(runInputGuardrails("hi", ["reg"], undefined)).rejects.toBeInstanceOf(
      PluginGuardrailTripwireError
    )
  })

  it("ignores unknown registered ids", async () => {
    await expect(runInputGuardrails("hi", ["does-not-exist"], undefined)).resolves.toBeUndefined()
  })
})

describe("runOutputGuardrails", () => {
  it("throws on an output tripwire", async () => {
    await expect(
      runOutputGuardrails("hi", "reply", [tripOutput("o")], undefined)
    ).rejects.toMatchObject({ stage: "output", guardrailId: "o" })
  })

  it("ignores input-typed guardrails", async () => {
    await expect(
      runOutputGuardrails("hi", "reply", [tripInput("i")], undefined)
    ).resolves.toBeUndefined()
  })
})

describe("createPiiOutputGuardrail", () => {
  it("passes clean output", async () => {
    const guard = createPiiOutputGuardrail()
    expect(await guard.run({ prompt: "p", output: "all clean" })).toEqual({
      tripwireTriggered: false,
    })
  })

  it("trips when output contains PII", async () => {
    const guard = createPiiOutputGuardrail()
    const r = await guard.run({ prompt: "p", output: "email me at a@b.com" })
    expect(r.tripwireTriggered).toBe(true)
  })
})
