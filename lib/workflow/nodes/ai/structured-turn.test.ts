import { runStructuredTurn, SchemaViolationError } from "./structured-turn"

const schema = {
  type: "object",
  properties: { verdict: { type: "string" }, score: { type: "number" } },
  required: ["verdict", "score"],
}

describe("runStructuredTurn", () => {
  it("returns a validated object on the first attempt", async () => {
    const runOnce = jest.fn(async () => ({ object: { verdict: "ok", score: 1 } }))
    const r = await runStructuredTurn({ outputSchema: schema, runOnce })
    expect(r).toEqual({ object: { verdict: "ok", score: 1 }, schemaValid: true, attempts: 1 })
    expect(runOnce).toHaveBeenCalledTimes(1)
    expect(runOnce).toHaveBeenCalledWith(undefined)
  })

  it("auto-fixes once and succeeds on the retry", async () => {
    const runOnce = jest
      .fn()
      .mockResolvedValueOnce({ object: { verdict: "ok" } }) // missing score
      .mockResolvedValueOnce({ object: { verdict: "ok", score: 2 } })
    const r = await runStructuredTurn({ outputSchema: schema, runOnce })
    expect(r.schemaValid).toBe(true)
    expect(r.attempts).toBe(2)
    // The retry carries a corrective instruction referencing the failing field.
    const fixArg = runOnce.mock.calls[1][0] as string
    expect(fixArg).toMatch(/score/)
  })

  it("throws SchemaViolationError after the retry is exhausted (fail mode)", async () => {
    const runOnce = jest.fn(async () => ({ object: { verdict: "ok" } }))
    await expect(runStructuredTurn({ outputSchema: schema, runOnce })).rejects.toBeInstanceOf(
      SchemaViolationError
    )
    expect(runOnce).toHaveBeenCalledTimes(2)
  })

  it("returns the unvalidated object in soft mode", async () => {
    const runOnce = jest.fn(async () => ({ object: { verdict: "ok" } }))
    const r = await runStructuredTurn({
      outputSchema: schema,
      onSchemaViolation: "soft",
      runOnce,
    })
    expect(r.schemaValid).toBe(false)
    expect(r.object).toEqual({ verdict: "ok" })
    expect(r.schemaErrors?.join("\n")).toMatch(/score/)
  })

  it("retries on a parse error then fails", async () => {
    const runOnce = jest.fn(async () => ({ parseError: "no JSON found" }))
    await expect(runStructuredTurn({ outputSchema: schema, runOnce })).rejects.toBeInstanceOf(
      SchemaViolationError
    )
    expect(runOnce).toHaveBeenCalledTimes(2)
  })

  it("honors maxFixRetries: 0 (single attempt, no retry)", async () => {
    const runOnce = jest.fn(async () => ({ object: {} }))
    await expect(
      runStructuredTurn({ outputSchema: schema, runOnce, maxFixRetries: 0 })
    ).rejects.toBeInstanceOf(SchemaViolationError)
    expect(runOnce).toHaveBeenCalledTimes(1)
  })

  it("passes through a non-object schema without enforcing", async () => {
    const runOnce = jest.fn(async () => ({ object: "anything" }))
    const r = await runStructuredTurn({
      outputSchema: { type: "string" },
      runOnce,
    })
    expect(r.schemaValid).toBe(true)
    expect(r.object).toBe("anything")
    expect(runOnce).toHaveBeenCalledTimes(1)
  })

  it("never throws for a non-object schema even in fail mode", async () => {
    const runOnce = jest.fn(async () => ({ parseError: "no JSON" }))
    const r = await runStructuredTurn({ outputSchema: { type: "string" }, runOnce })
    expect(r.schemaValid).toBe(false)
  })
})
