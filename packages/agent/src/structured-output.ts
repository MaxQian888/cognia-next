import * as v from "valibot"

import type { JsonSchemaContract } from "./agent-definition"
import { contentDigest } from "./digest"
import { StructuredOutputError } from "./errors"
import type { AgentTurnOutcome } from "./types"
import { valibotToJsonSchema } from "./valibot-json-schema"

/** Build an output contract from a Valibot schema. */
export function defineOutput(schema: v.GenericSchema): JsonSchemaContract {
  const json = valibotToJsonSchema(schema)
  return { schema: json, schemaDigest: contentDigest(json) }
}

/** Build an output contract from a hand-written JSON Schema. */
export function defineRawOutput(schema: Record<string, unknown>): JsonSchemaContract {
  return { schema, schemaDigest: contentDigest(schema) }
}

/**
 * Read a turn's structured output, typed.
 *
 * Absent output and invalid output are different failures and are reported
 * differently. The old contract folded both into a `parseError` string on an
 * otherwise successful result, which a caller had to know to look for.
 */
export function parseStructuredOutput<TOutput>(
  schema: v.GenericSchema<unknown, TOutput>,
  outcome: AgentTurnOutcome
): TOutput {
  const received = outcome.result.structuredOutput
  if (received === undefined) {
    throw new StructuredOutputError(
      ["the turn produced no structured output; the host may not support structured-output-v1"],
      undefined
    )
  }
  const parsed = v.safeParse(schema, received)
  if (!parsed.success) {
    throw new StructuredOutputError(
      parsed.issues.map((issue) => {
        const dotted = issue.path?.map((item) => String(item.key)).join(".")
        return dotted ? `${dotted}: ${issue.message}` : issue.message
      }),
      received
    )
  }
  return parsed.output
}

/** True when the turn carried structured output at all. */
export function hasStructuredOutput(outcome: AgentTurnOutcome): boolean {
  return outcome.result.structuredOutput !== undefined
}
