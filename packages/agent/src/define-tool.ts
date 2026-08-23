import * as v from "valibot"

import { computeToolSchemaDigest, type AgentToolReference } from "./agent-definition"
import { ToolSchemaError } from "./errors"
import type {
  ClientInvocationContext,
  ClientToolRegistration,
  JsonSchema,
  SideEffectClass,
} from "./types"
import { valibotToJsonSchema } from "./valibot-json-schema"

export interface ToolSpec<TInput, TOutput> {
  name: string
  description: string
  input: v.GenericSchema<unknown, TInput>
  output?: v.GenericSchema<unknown, TOutput>
  /** Defaults to `none`; anything that writes must say so. */
  sideEffect?: SideEffectClass
  timeoutMs?: number
  handler: (input: TInput, context: ClientInvocationContext) => TOutput | Promise<TOutput>
}

export interface RawToolSpec {
  name: string
  description: string
  /**
   * A JSON Schema the SDK cannot type. Handler input is `unknown` by design —
   * the loss of inference is the visible cost of stepping outside the
   * convertible subset, rather than a false sense of safety.
   */
  inputSchema: JsonSchema
  outputSchema?: JsonSchema
  sideEffect?: SideEffectClass
  timeoutMs?: number
  handler: (input: unknown, context: ClientInvocationContext) => unknown | Promise<unknown>
}

export interface DefinedTool<TInput = unknown, TOutput = unknown> {
  readonly name: string
  /** The contract stored in an agent definition. Carries no handler. */
  readonly reference: AgentToolReference
  /** What `client.tools.register` needs. `handlerId` is the schema digest. */
  readonly registration: ClientToolRegistration
  /** Validates input, runs the handler, validates output. */
  invoke(rawInput: unknown, context: ClientInvocationContext): Promise<TOutput>
  readonly handler: (input: TInput, context: ClientInvocationContext) => TOutput | Promise<TOutput>
}

function issuesOf(result: v.SafeParseResult<v.GenericSchema>): string[] {
  return (result.issues ?? []).map((issue) => {
    const dotted = issue.path?.map((item) => String(item.key)).join(".")
    return dotted ? `${dotted}: ${issue.message}` : issue.message
  })
}

function build(
  name: string,
  description: string,
  inputSchema: JsonSchema,
  outputSchema: JsonSchema | undefined,
  sideEffect: SideEffectClass,
  timeoutMs: number | undefined,
  invoke: DefinedTool["invoke"],
  handler: DefinedTool["handler"]
): DefinedTool {
  const contract = {
    name,
    description,
    inputSchema,
    ...(outputSchema !== undefined ? { outputSchema } : {}),
    sideEffect,
  }
  const schemaDigest = computeToolSchemaDigest(contract)
  return {
    name,
    reference: { ...contract, schemaDigest },
    registration: {
      // The digest is the handler id: the host preflights that the registered
      // handler matches the contract the definition recorded, and an id derived
      // from the contract makes a mismatch impossible to paper over.
      handlerId: `${name}@${schemaDigest}`,
      name,
      description,
      inputSchema,
      ...(outputSchema !== undefined ? { outputSchema } : {}),
      sideEffect,
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    },
    invoke,
    handler,
  }
}

/**
 * A tool whose input and output types are derived from Valibot schemas.
 *
 * The schemas do three jobs at once: they type the handler, they become the
 * JSON Schema the model sees, and they are the runtime check on both the input
 * arriving from the host and the output going back. Nothing has to be kept in
 * sync by hand, which is the whole reason for deriving rather than declaring.
 */
export function defineTool<TInput, TOutput>(
  spec: ToolSpec<TInput, TOutput>
): DefinedTool<TInput, TOutput> {
  const inputSchema = valibotToJsonSchema(spec.input)
  const outputSchema = spec.output ? valibotToJsonSchema(spec.output) : undefined
  const sideEffect = spec.sideEffect ?? "none"

  const invoke = async (rawInput: unknown, context: ClientInvocationContext): Promise<TOutput> => {
    const parsedInput = v.safeParse(spec.input, rawInput)
    if (!parsedInput.success) {
      throw new ToolSchemaError({
        side: "input",
        toolName: spec.name,
        issues: issuesOf(parsedInput as v.SafeParseResult<v.GenericSchema>),
      })
    }
    const output = await spec.handler(parsedInput.output as TInput, context)
    if (!spec.output) return output
    const parsedOutput = v.safeParse(spec.output, output)
    if (!parsedOutput.success) {
      throw new ToolSchemaError({
        side: "output",
        toolName: spec.name,
        issues: issuesOf(parsedOutput as v.SafeParseResult<v.GenericSchema>),
      })
    }
    return parsedOutput.output as TOutput
  }

  return build(
    spec.name,
    spec.description,
    inputSchema,
    outputSchema,
    sideEffect,
    spec.timeoutMs,
    invoke as DefinedTool["invoke"],
    spec.handler as DefinedTool["handler"]
  ) as DefinedTool<TInput, TOutput>
}

/** The escape hatch for a contract outside the convertible Valibot subset. */
export function defineRawTool(spec: RawToolSpec): DefinedTool<unknown, unknown> {
  const invoke = async (rawInput: unknown, context: ClientInvocationContext) =>
    spec.handler(rawInput, context)
  return build(
    spec.name,
    spec.description,
    spec.inputSchema,
    spec.outputSchema,
    spec.sideEffect ?? "none",
    spec.timeoutMs,
    invoke,
    spec.handler
  )
}
