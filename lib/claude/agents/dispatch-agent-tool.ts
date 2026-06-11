// The `dispatch_agent` tool — lets the running agent dispatch one or more
// registered subagents, with controlled depth-N nesting. It rides the EXISTING
// plugin-tool round-trip (no sidecar/Rust changes): a manifest entry surfaces
// it to the sidecar's `cognia-plugin-tools` MCP server, the model's call comes
// back as a `plugin_tool_exec` event, and `handlePluginToolExec` routes the
// `dispatch_agent` name to the renderer's `dispatchSubagent` (which lives in the
// renderer — exactly where this tool must execute).
//
// Three call modes (one flat schema; the model fills the relevant fields):
//   • single   — `{ subagentId, prompt, toolsEnabled?, background? }`
//   • parallel — `{ dispatches: [ {subagentId, prompt, ...}, ... ] }`
//   • collect  — `{ collect: "<runId>" }` to await a backgrounded run's result
//
// The manifest entry is only injected when nesting is enabled AND the calling
// agent's depth is below the cap (`lib/plugin/bridge/sidecar-tools-bridge.ts`);
// withholding the entry at the cap is how we re-implement Claude Code's "Agent
// tool removed from subagents" rule, parameterized to depth-N.

import type { PluginToolManifestEntry } from "@/lib/plugin/bridge/sidecar-tools-bridge"

export const DISPATCH_AGENT_TOOL_NAME = "dispatch_agent"

/** Synthetic plugin id namespacing the tool in the manifest / audit trail. */
export const DISPATCH_AGENT_PLUGIN_ID = "cognia-dispatch-agent"

/** A subagent the dispatcher may target (drives the `subagentId` enum). */
export interface DispatchAgentAvailableSubagent {
  id: string
  description: string
}

/** A single normalized dispatch request. */
export interface NormalizedDispatch {
  subagentId: string
  prompt: string
  toolsEnabled: boolean
  background: boolean
}

/** Parsed `dispatch_agent` call, discriminated by mode. */
export type ParsedDispatchAgentCall =
  | { mode: "dispatch"; dispatches: NormalizedDispatch[] }
  | { mode: "collect"; runId: string }
  | { mode: "error"; message: string }

const DISPATCH_ITEM_SCHEMA = {
  type: "object",
  properties: {
    subagentId: { type: "string", description: "Id of the registered subagent to run." },
    prompt: { type: "string", description: "The task prompt handed to the subagent." },
    toolsEnabled: {
      type: "boolean",
      description: "Run the subagent with the tool-enabled loop (default true).",
    },
    background: {
      type: "boolean",
      description:
        "Detach the run and return a runId immediately; collect the result later with `collect`.",
    },
  },
  required: ["subagentId", "prompt"],
} as const

/**
 * Build the tool's JSON schema. When `available` is non-empty the `subagentId`
 * fields are constrained to an enum so the model can only target known ids
 * (this doubles as subagent discovery — it sees the available agents inline).
 */
export function buildDispatchAgentSchema(available: DispatchAgentAvailableSubagent[]): object {
  const ids = available.map((a) => a.id)
  const idSchema: Record<string, unknown> = {
    type: "string",
    description: "Id of the registered subagent to run.",
  }
  if (ids.length > 0) idSchema.enum = ids

  const item = {
    ...DISPATCH_ITEM_SCHEMA,
    properties: { ...DISPATCH_ITEM_SCHEMA.properties, subagentId: idSchema },
  }

  return {
    type: "object",
    properties: {
      subagentId: idSchema,
      prompt: { type: "string", description: "Task prompt (single-dispatch form)." },
      toolsEnabled: {
        type: "boolean",
        description: "Run with the tool-enabled loop (default true).",
      },
      background: {
        type: "boolean",
        description: "Detach this single dispatch and return a runId immediately.",
      },
      dispatches: {
        type: "array",
        description: "Parallel form: dispatch several subagents at once.",
        items: item,
      },
      collect: {
        type: "string",
        description: "Await a previously backgrounded run by its runId.",
      },
    },
  }
}

/** Description lists the available subagents so the model can choose well. */
function buildDescription(available: DispatchAgentAvailableSubagent[]): string {
  const base =
    "Dispatch one or more registered subagents to work on a task and return their results. " +
    "Use the single form `{subagentId, prompt}`, the parallel form `{dispatches:[...]}` to fan out, " +
    'or `{collect:"<runId>"}` to await a backgrounded run. Subagents run in isolated context; ' +
    "only their final output returns to you."
  if (available.length === 0) return base
  const list = available.map((a) => `- ${a.id}: ${a.description}`).join("\n")
  return `${base}\n\nAvailable subagents:\n${list}`
}

/** The manifest entry that surfaces `dispatch_agent` to the sidecar tool server. */
export function buildDispatchAgentManifestEntry(
  available: DispatchAgentAvailableSubagent[]
): PluginToolManifestEntry {
  return {
    name: DISPATCH_AGENT_TOOL_NAME,
    description: buildDescription(available),
    jsonSchema: buildDispatchAgentSchema(available),
    pluginId: DISPATCH_AGENT_PLUGIN_ID,
    // A dispatched subagent runs a full bounded agent loop (its own
    // depth/cycle/budget/timeout guards apply); the synchronous round-trip can
    // far exceed the 120s plugin-tool safety net, so disable that timeout here
    // rather than sever a still-running subagent.
    timeoutMs: 0,
  }
}

function normalizeOne(raw: unknown): NormalizedDispatch | null {
  if (!raw || typeof raw !== "object") return null
  const subagentId = (raw as { subagentId?: unknown }).subagentId
  const prompt = (raw as { prompt?: unknown }).prompt
  if (typeof subagentId !== "string" || !subagentId.trim()) return null
  if (typeof prompt !== "string" || !prompt.trim()) return null
  return {
    subagentId: subagentId.trim(),
    prompt,
    // Default true — the dispatched subagent normally needs tools.
    toolsEnabled: (raw as { toolsEnabled?: unknown }).toolsEnabled !== false,
    background: (raw as { background?: unknown }).background === true,
  }
}

/**
 * Normalize raw model args into a discriminated call. `collect` wins over a
 * dispatch payload; the parallel `dispatches` array wins over the single form.
 * Returns an `error` mode (never throws) so the handler can surface a clean
 * tool-result string to the model.
 */
export function parseDispatchAgentArgs(args: Record<string, unknown>): ParsedDispatchAgentCall {
  const collect = args.collect
  if (typeof collect === "string" && collect.trim()) {
    return { mode: "collect", runId: collect.trim() }
  }

  if (Array.isArray(args.dispatches)) {
    const dispatches: NormalizedDispatch[] = []
    for (const item of args.dispatches) {
      const norm = normalizeOne(item)
      if (norm) dispatches.push(norm)
    }
    if (dispatches.length === 0) {
      return { mode: "error", message: "dispatch_agent: `dispatches` had no valid entries." }
    }
    return { mode: "dispatch", dispatches }
  }

  const single = normalizeOne(args)
  if (single) return { mode: "dispatch", dispatches: [single] }

  return {
    mode: "error",
    message:
      'dispatch_agent: provide `{subagentId, prompt}`, `{dispatches:[...]}`, or `{collect:"<runId>"}`.',
  }
}
