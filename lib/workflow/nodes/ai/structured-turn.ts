/**
 * `runStructuredTurn` — the typed-output contract for a harness unit (D3).
 *
 * Wraps a model turn (`runOnce`) with: parse → validate against a JSON object
 * schema → on violation, ONE bounded auto-fix retry (re-prompt carrying the
 * concrete errors) → still failing ⇒ `soft` returns the unvalidated object,
 * `fail` (default) throws so the node's existing errorPolicy machinery
 * (`lib/workflow/runtime/node-failure.ts`: retry / error-branch / continue)
 * takes over. Typed output is a real contract, not a hint — hence `fail` is the
 * default.
 *
 * The mechanism is forced: the sidecar `query()` channel returns free text and
 * cannot do provider-native structured output, so prompt-injection (a JSON
 * instruction + a corrective re-prompt) is the only mechanism that works for
 * any agentic turn. `runOnce` owns the actual model call; this helper owns the
 * validate/retry policy.
 */

import {
  validateAgainstJsonSchema,
  summarizeZodError,
  isValidatableObjectSchema,
} from "./schema-validate"

export type SchemaViolationMode = "fail" | "soft"

export interface StructuredTurnResult {
  /** Parsed model output (validated when `schemaValid`, best-effort otherwise). */
  object: unknown
  /** Whether `object` satisfied the schema. */
  schemaValid: boolean
  /** Stable `path: message` lines when validation failed (soft mode only). */
  schemaErrors?: string[]
  /** Model calls made: 1 = no retry, 2 = one auto-fix retry. */
  attempts: number
}

export interface RunStructuredTurnInput {
  /** JSON object schema the output must satisfy. */
  outputSchema: Record<string, unknown>
  /** `fail` (default) throws on violation; `soft` returns the unvalidated object. */
  onSchemaViolation?: SchemaViolationMode
  /**
   * Run one model turn. `fixInstruction` is `undefined` on the first call and a
   * corrective re-prompt on the single retry — the caller appends it to the
   * system/user prompt. Returns the parsed object, or `parseError` when JSON
   * could not be extracted from the completion.
   */
  runOnce: (
    fixInstruction: string | undefined
  ) => Promise<{ object?: unknown; parseError?: string }>
  /** Bounded retry budget. Defaults to 1 (n8n auto-fix parity). */
  maxFixRetries?: number
}

/** Thrown when typed output cannot be produced and the node is in `fail` mode. */
export class SchemaViolationError extends Error {
  readonly schemaErrors: string[]
  constructor(schemaErrors: string[]) {
    super(
      `Structured output did not satisfy the required schema after auto-fix:\n` +
        schemaErrors.map((e) => `  - ${e}`).join("\n")
    )
    this.name = "SchemaViolationError"
    this.schemaErrors = schemaErrors
  }
}

export async function runStructuredTurn(
  input: RunStructuredTurnInput
): Promise<StructuredTurnResult> {
  const mode = input.onSchemaViolation ?? "fail"
  const maxFix = Math.max(0, input.maxFixRetries ?? 1)

  // Non-object schemas carry nothing to enforce: a single pass, accept whatever
  // parses. Validation still runs (returns ok) so the code path is uniform.
  const enforcing = isValidatableObjectSchema(input.outputSchema)

  let attempt = 0
  let fix: string | undefined
  let lastObject: unknown
  let lastErrors: string[] = []

  while (attempt <= maxFix) {
    attempt += 1
    const { object, parseError } = await input.runOnce(fix)
    lastObject = object

    if (parseError) {
      lastErrors = [`(root): ${parseError}`]
    } else {
      const validation = validateAgainstJsonSchema(input.outputSchema, object)
      if (validation.ok) {
        return { object, schemaValid: true, attempts: attempt }
      }
      lastErrors = validation.errors
    }

    // A non-enforcing schema only "fails" when JSON itself couldn't be parsed;
    // still worth one retry, but it's never a schema contract.
    if (attempt <= maxFix) {
      fix = summarizeZodError(lastErrors)
    }
  }

  if (mode === "soft" || !enforcing) {
    return {
      object: lastObject,
      schemaValid: false,
      schemaErrors: lastErrors,
      attempts: attempt,
    }
  }
  throw new SchemaViolationError(lastErrors)
}
