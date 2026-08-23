import * as v from "valibot"

import { StructuredOutputError } from "./errors"
import {
  defineOutput,
  defineRawOutput,
  hasStructuredOutput,
  parseStructuredOutput,
} from "./structured-output"
import type { AgentTurnOutcome } from "./types"

const schema = v.object({ summary: v.string(), risk: v.picklist(["low", "high"]) })

function outcome(structuredOutput?: unknown): AgentTurnOutcome {
  return {
    status: "completed",
    result: {
      status: "completed",
      text: "done",
      ...(structuredOutput !== undefined ? { structuredOutput } : {}),
    },
  }
}

describe("defineOutput", () => {
  it("derives a JSON Schema and its digest", () => {
    const contract = defineOutput(schema)
    expect(contract.schema).toMatchObject({ type: "object", required: ["summary", "risk"] })
    expect(contract.schemaDigest).toMatch(/^sha256-/)
  })

  it("gives an identical schema an identical digest", () => {
    expect(defineOutput(schema).schemaDigest).toBe(defineOutput(schema).schemaDigest)
  })

  it("accepts a hand-written schema through the raw form", () => {
    const contract = defineRawOutput({ type: "object" })
    expect(contract).toEqual({ schema: { type: "object" }, schemaDigest: expect.any(String) })
  })
})

describe("parseStructuredOutput", () => {
  it("returns typed output on the happy path", () => {
    const parsed = parseStructuredOutput(schema, outcome({ summary: "ok", risk: "low" }))
    expect(parsed).toEqual({ summary: "ok", risk: "low" })
  })

  it("distinguishes absent output from invalid output", () => {
    expect(() => parseStructuredOutput(schema, outcome())).toThrow(
      expect.objectContaining({ code: "output_invalid", received: undefined })
    )
    expect(() => parseStructuredOutput(schema, outcome())).toThrow(/no structured output/)
  })

  it("reports which field failed and what it received", () => {
    let thrown: unknown
    try {
      parseStructuredOutput(schema, outcome({ summary: "ok", risk: "medium" }))
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(StructuredOutputError)
    expect(thrown).toMatchObject({
      code: "output_invalid",
      issues: [expect.stringContaining("risk")],
      received: { summary: "ok", risk: "medium" },
    })
  })

  it("is terminal rather than a string on a successful result", () => {
    const failed = outcome({ summary: 7 })
    expect(failed.status).toBe("completed")
    expect(() => parseStructuredOutput(schema, failed)).toThrow(StructuredOutputError)
  })
})

describe("hasStructuredOutput", () => {
  it("reports presence without parsing", () => {
    expect(hasStructuredOutput(outcome({ anything: true }))).toBe(true)
    expect(hasStructuredOutput(outcome())).toBe(false)
  })
})
