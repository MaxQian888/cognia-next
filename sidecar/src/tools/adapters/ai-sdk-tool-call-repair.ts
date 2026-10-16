// Deterministic repair for tool calls the AI SDK could not parse.
//
// Models routed through relays and OpenAI-compatible gateways often call a
// tool by a near-miss name (`Read` for `read`, `functions.read`) or spell an
// argument the way another agent's tool does (`read({ path })` where this
// schema says `file_path`). Unrepaired, each costs a failed call the model has
// to notice and correct, and recovery is not guaranteed. This repairs only the
// unambiguous cases and never guesses across tools: a name must match one tool
// exactly up to case or a wrapper prefix, and an argument is renamed only onto
// a required property it is missing, from a key the schema does not declare,
// when exactly one such key is an alias of it. The SDK validates the repaired
// call again, so a repair that still does not fit fails exactly as before.

import { InvalidToolInputError, NoSuchToolError } from "ai"

/** The repaired call shape the AI SDK expects back (`LanguageModelV4ToolCall`). */
export interface RepairableToolCall {
  type: "tool-call"
  toolCallId: string
  toolName: string
  /** Stringified JSON arguments. */
  input: string
  [key: string]: unknown
}

export interface ToolCallRepairOptions {
  toolCall: RepairableToolCall
  tools: Record<string, unknown>
  inputSchema: (options: { toolName: string }) => PromiseLike<unknown>
  error: unknown
}

/** Wrapper prefixes some models put in front of a function name. */
const NAME_PREFIXES = ["functions.", "functions/", "tools.", "tool."] as const

/**
 * Argument spellings other agents' tools use for the same value, keyed by the
 * property this schema declares. Compared after {@link normalizeKey}.
 */
const ARGUMENT_ALIASES: Readonly<Record<string, readonly string[]>> = {
  filepath: ["path", "file", "filename", "target_file", "notebook_path"],
  path: ["filepath", "file", "filename", "target_file"],
  command: ["cmd"],
  oldstring: ["oldstr", "oldtext", "search"],
  newstring: ["newstr", "newtext", "replace"],
}

/** `file_path`, `filePath` and `file-path` are one key. */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[_\-\s]/g, "")
}

/** The one available tool `requested` unambiguously names, if any. */
export function resolveToolName(requested: string, available: readonly string[]): string | null {
  if (available.includes(requested)) return requested
  const candidates = new Set<string>([requested])
  for (const prefix of NAME_PREFIXES) {
    if (requested.toLowerCase().startsWith(prefix)) candidates.add(requested.slice(prefix.length))
  }
  const matches = available.filter((name) =>
    [...candidates].some((candidate) => candidate.toLowerCase() === name.toLowerCase())
  )
  return matches.length === 1 ? matches[0]! : null
}

interface ObjectSchema {
  properties?: Record<string, unknown>
  required?: unknown
}

/**
 * Rename aliased arguments onto the required properties they stand for.
 * Returns the repaired arguments, or null when nothing could be repaired.
 */
export function renameAliasedArguments(
  input: unknown,
  schema: unknown
): Record<string, unknown> | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null
  if (!schema || typeof schema !== "object") return null
  const { properties, required } = schema as ObjectSchema
  if (!properties || typeof properties !== "object" || !Array.isArray(required)) return null
  const declared = new Set(Object.keys(properties))
  const args = { ...(input as Record<string, unknown>) }
  let renamed = false
  for (const property of required) {
    if (typeof property !== "string" || property in args) continue
    const wanted = normalizeKey(property)
    const aliases = new Set([wanted, ...(ARGUMENT_ALIASES[wanted] ?? [])])
    const sources = Object.keys(args).filter(
      (key) => !declared.has(key) && aliases.has(normalizeKey(key))
    )
    if (sources.length !== 1) continue
    const source = sources[0]!
    args[property] = args[source]
    delete args[source]
    renamed = true
  }
  return renamed ? args : null
}

/** The AI SDK `repairToolCall` callback for the built-in agent loop. */
export function createToolCallRepair(): (
  options: ToolCallRepairOptions
) => Promise<RepairableToolCall | null> {
  /**
   * The call's arguments with aliases renamed for `toolName`'s schema, or null
   * when they need no repair or cannot be read.
   */
  const repairArguments = async (
    toolName: string,
    rawInput: string,
    inputSchema: ToolCallRepairOptions["inputSchema"]
  ): Promise<string | null> => {
    let parsed: unknown
    try {
      parsed = JSON.parse(rawInput)
    } catch {
      return null
    }
    let schema: unknown
    try {
      schema = await inputSchema({ toolName })
    } catch {
      return null
    }
    const repaired = renameAliasedArguments(parsed, schema)
    return repaired ? JSON.stringify(repaired) : null
  }

  return async ({ toolCall, tools, inputSchema, error }) => {
    if (NoSuchToolError.isInstance(error)) {
      const name = resolveToolName(toolCall.toolName, Object.keys(tools))
      if (!name || name === toolCall.toolName) return null
      // The SDK repairs a call once, so fix its arguments in the same pass: a
      // model that misspells the tool usually spells its arguments the other
      // agent's way too.
      const input = await repairArguments(name, toolCall.input, inputSchema)
      return { ...toolCall, toolName: name, ...(input ? { input } : {}) }
    }
    if (InvalidToolInputError.isInstance(error)) {
      if (!Object.hasOwn(tools, toolCall.toolName)) return null
      const input = await repairArguments(toolCall.toolName, toolCall.input, inputSchema)
      return input ? { ...toolCall, input } : null
    }
    return null
  }
}
