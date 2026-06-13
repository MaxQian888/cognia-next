/**
 * Plugin AI-tool eval harness — engine.
 *
 * A declarative way to test that the model uses a plugin's tools correctly,
 * inspired by Raycast's `ray evals` + `ai.yaml`. A plugin ships an `evals.yaml`
 * next to its manifest; `pnpm plugin:eval` runs each case through this engine.
 *
 * Two modes, because there are two distinct things to verify:
 *
 *  - **offline** (deterministic, CI-runnable): invoke the plugin tool named by
 *    `expect.callsTool` with concrete `args` (or the primitive entries of
 *    `expect.withArgs`) and assert the tool's OUTPUT against `expect.output`.
 *    This validates the tool's contract / schema — no model involved, so
 *    `callsTool` is an INPUT here, not an assertion.
 *
 *  - **online** (opt-in, needs a real model + OAuth token): send `prompt` plus
 *    the plugin's tool manifest to the model and assert that it CHOSE the right
 *    tool with the right args (`callsTool` / `withArgs` / `notCallsTool`) and
 *    that the final text matches `expect.output`. This validates model
 *    selection.
 *
 * The engine is pure: callers inject `invokeTool` (offline) or `sendToModel`
 * (online), so it has no I/O and is fully unit-testable.
 */

export interface EvalMatcher {
  /** Substring that must appear (case-sensitive) in the stringified value. */
  includes?: string
  /** Deep-equality target. */
  equals?: unknown
  /** RegExp source tested against the stringified value. */
  regex?: string
}

/** A matcher, or a bare primitive shorthand for `{ equals: <primitive> }`. */
export type EvalFieldExpect = EvalMatcher | string | number | boolean | null

export interface EvalExpect {
  /** The plugin tool the model is expected to call (offline: the tool to run). */
  callsTool?: string
  /** A tool the model must NOT call (online only). */
  notCallsTool?: string
  /** Per-argument matchers for the chosen tool call. */
  withArgs?: Record<string, EvalFieldExpect>
  /** Matcher applied to the tool output (offline) / final model text (online). */
  output?: EvalFieldExpect
}

export interface EvalCase {
  name: string
  prompt: string
  /** Plugin config overrides applied for this case. */
  config?: Record<string, unknown>
  /** Concrete args for OFFLINE tool invocation (falls back to primitive withArgs). */
  args?: Record<string, unknown>
  expect: EvalExpect
}

export interface EvalSuite {
  evals: EvalCase[]
}

export type EvalMode = "offline" | "online"

export interface EvalResult {
  name: string
  mode: EvalMode
  passed: boolean
  /** Human-readable reasons the case failed; empty when passed. */
  failures: string[]
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

function isMatcher(v: EvalFieldExpect): v is EvalMatcher {
  return typeof v === "object" && v !== null && ("includes" in v || "equals" in v || "regex" in v)
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value
  if (value === undefined) return ""
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a === null || b === null) return a === b
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]))
  }
  if (typeof a === "object" && typeof b === "object") {
    const ak = Object.keys(a as object)
    const bk = Object.keys(b as object)
    return (
      ak.length === bk.length &&
      ak.every((k) =>
        deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k])
      )
    )
  }
  return false
}

/**
 * Test a single value against an expectation. Returns null on success, or a
 * human-readable failure description.
 */
export function matchField(
  label: string,
  actual: unknown,
  expected: EvalFieldExpect
): string | null {
  if (!isMatcher(expected)) {
    return deepEqual(actual, expected)
      ? null
      : `${label}: expected ${stringify(expected)}, got ${stringify(actual)}`
  }
  if (expected.includes !== undefined) {
    if (!stringify(actual).includes(expected.includes)) {
      return `${label}: expected to include "${expected.includes}", got ${stringify(actual)}`
    }
  }
  if (expected.equals !== undefined) {
    if (!deepEqual(actual, expected.equals)) {
      return `${label}: expected ${stringify(expected.equals)}, got ${stringify(actual)}`
    }
  }
  if (expected.regex !== undefined) {
    if (!new RegExp(expected.regex).test(stringify(actual))) {
      return `${label}: expected to match /${expected.regex}/, got ${stringify(actual)}`
    }
  }
  return null
}

function matchArgs(
  actualArgs: Record<string, unknown>,
  withArgs: Record<string, EvalFieldExpect>
): string[] {
  const failures: string[] = []
  for (const [key, expected] of Object.entries(withArgs)) {
    const fail = matchField(`args.${key}`, actualArgs[key], expected)
    if (fail) failures.push(fail)
  }
  return failures
}

/** Derive concrete invocation args from the primitive entries of `withArgs`. */
function concreteArgsFromWithArgs(
  withArgs: Record<string, EvalFieldExpect> | undefined
): Record<string, unknown> {
  const args: Record<string, unknown> = {}
  if (!withArgs) return args
  for (const [key, value] of Object.entries(withArgs)) {
    if (!isMatcher(value)) args[key] = value
    else if (value.equals !== undefined) args[key] = value.equals
  }
  return args
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * Validate a parsed `evals` document into an {@link EvalSuite}. Accepts the
 * object already parsed from YAML/JSON (parsing stays in the runner so this
 * module has no yaml dependency). Throws on a structurally invalid suite.
 */
export function parseEvalSuite(doc: unknown): EvalSuite {
  if (
    typeof doc !== "object" ||
    doc === null ||
    !Array.isArray((doc as { evals?: unknown }).evals)
  ) {
    throw new Error("evals file must have an `evals:` array")
  }
  const evals = (doc as { evals: unknown[] }).evals.map((raw, i) => {
    if (typeof raw !== "object" || raw === null) {
      throw new Error(`evals[${i}] must be an object`)
    }
    const c = raw as Record<string, unknown>
    if (typeof c.name !== "string" || c.name.trim() === "") {
      throw new Error(`evals[${i}].name is required`)
    }
    if (typeof c.prompt !== "string" || c.prompt.trim() === "") {
      throw new Error(`evals[${i}].prompt is required`)
    }
    if (typeof c.expect !== "object" || c.expect === null) {
      throw new Error(`evals[${i}].expect is required`)
    }
    return {
      name: c.name,
      prompt: c.prompt,
      config: (c.config as Record<string, unknown> | undefined) ?? undefined,
      args: (c.args as Record<string, unknown> | undefined) ?? undefined,
      expect: c.expect as EvalExpect,
    } satisfies EvalCase
  })
  return { evals }
}

// ---------------------------------------------------------------------------
// Runners
// ---------------------------------------------------------------------------

export interface OfflineDeps {
  /** Invoke a plugin tool by name with concrete args, returning its result. */
  invokeTool: (toolName: string, args: Record<string, unknown>) => Promise<unknown>
}

/**
 * Run a case offline: invoke `expect.callsTool` and assert `expect.output`.
 * `callsTool` is required (it names the tool to run); `withArgs` matcher entries
 * are not asserted here (no model to assert against).
 */
export async function runEvalOffline(c: EvalCase, deps: OfflineDeps): Promise<EvalResult> {
  const failures: string[] = []
  const tool = c.expect.callsTool
  if (!tool) {
    return {
      name: c.name,
      mode: "offline",
      passed: false,
      failures: ["offline mode requires `expect.callsTool` to name the tool to run"],
    }
  }
  const args = c.args ?? concreteArgsFromWithArgs(c.expect.withArgs)
  let output: unknown
  try {
    output = await deps.invokeTool(tool, args)
  } catch (err) {
    return {
      name: c.name,
      mode: "offline",
      passed: false,
      failures: [`tool "${tool}" threw: ${err instanceof Error ? err.message : String(err)}`],
    }
  }
  if (c.expect.output !== undefined) {
    const fail = matchField("output", output, c.expect.output)
    if (fail) failures.push(fail)
  }
  return { name: c.name, mode: "offline", passed: failures.length === 0, failures }
}

export interface ModelTurn {
  toolCalls: Array<{ name: string; args: Record<string, unknown> }>
  outputText: string
}

export interface OnlineDeps {
  /** Send the prompt + plugin tools to a real model and capture the turn. */
  sendToModel: (prompt: string, config?: Record<string, unknown>) => Promise<ModelTurn>
}

/**
 * Run a case online: send the prompt to a real model and assert tool selection
 * (`callsTool` / `withArgs` / `notCallsTool`) and final text (`output`).
 */
export async function runEvalOnline(c: EvalCase, deps: OnlineDeps): Promise<EvalResult> {
  const failures: string[] = []
  let turn: ModelTurn
  try {
    turn = await deps.sendToModel(c.prompt, c.config)
  } catch (err) {
    return {
      name: c.name,
      mode: "online",
      passed: false,
      failures: [`model call threw: ${err instanceof Error ? err.message : String(err)}`],
    }
  }

  const { expect: exp } = c

  if (exp.callsTool) {
    const call = turn.toolCalls.find((t) => t.name === exp.callsTool)
    if (!call) {
      failures.push(
        `expected the model to call "${exp.callsTool}"; it called ` +
          `[${turn.toolCalls.map((t) => t.name).join(", ") || "nothing"}]`
      )
    } else if (exp.withArgs) {
      failures.push(...matchArgs(call.args, exp.withArgs))
    }
  }

  if (exp.notCallsTool && turn.toolCalls.some((t) => t.name === exp.notCallsTool)) {
    failures.push(`model called "${exp.notCallsTool}" but the case forbids it`)
  }

  if (exp.output !== undefined) {
    const fail = matchField("output", turn.outputText, exp.output)
    if (fail) failures.push(fail)
  }

  return { name: c.name, mode: "online", passed: failures.length === 0, failures }
}

/** Run a whole suite in one mode. */
export async function runEvalSuite(
  suite: EvalSuite,
  mode: EvalMode,
  deps: OfflineDeps | OnlineDeps
): Promise<EvalResult[]> {
  const results: EvalResult[] = []
  for (const c of suite.evals) {
    results.push(
      mode === "offline"
        ? await runEvalOffline(c, deps as OfflineDeps)
        : await runEvalOnline(c, deps as OnlineDeps)
    )
  }
  return results
}
