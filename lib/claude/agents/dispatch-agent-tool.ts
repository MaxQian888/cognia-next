// The `dispatch_agent` tool — lets the running agent dispatch one or more
// registered subagents, with controlled depth-N nesting. It rides the EXISTING
// plugin-tool round-trip (no sidecar/Rust changes): a manifest entry surfaces
// it to the sidecar's `cognia-plugin-tools` MCP server, the model's call comes
// back as a `plugin_tool_exec` event, and `handlePluginToolExec` routes the
// `dispatch_agent` name to the renderer's `dispatchSubagent` (which lives in the
// renderer — exactly where this tool must execute).
//
// Four call modes (one flat schema; the model fills the relevant fields):
//   • single   — `{ subagentId, prompt, toolsEnabled?, background? }`
//   • parallel — `{ dispatches: [ {subagentId, prompt, ...}, ... ] }`
//   • collect  — `{ collect: "<runId>" }` to await a backgrounded run's result
//   • resume   — `{ resume: "<runId>", prompt }` to continue a FINISHED run
//     with a follow-up (the prior prompt + outcome are re-framed as context)
//
// The manifest entry is only injected when nesting is enabled AND the calling
// agent's depth is below the cap (`lib/plugin/bridge/sidecar-tools-bridge.ts`);
// withholding the entry at the cap is how we re-implement Claude Code's "Agent
// tool removed from subagents" rule, parameterized to depth-N.

import type { PluginToolManifestEntry } from "@/lib/plugin/bridge/sidecar-tools-bridge"

export const DISPATCH_AGENT_TOOL_NAME = "dispatch_agent"

/**
 * Claude Code parity alias. The canonical advertised tool stays `dispatch_agent`
 * (descriptive, and referenced across the CLI/renderer/tests), but the handler
 * also accepts this name and CC-style `subagent_type` args, so a model biased
 * toward Claude Code's `Task`/`Agent` naming still dispatches correctly.
 */
export const TASK_TOOL_NAME = "Task"

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
  /**
   * Per-call model override (Claude Code `Agent(model=...)` parity). Overlays
   * the subagent definition's own `model` for THIS dispatch only, so a cheap
   * scouting run and an expensive synthesis run can target the same agent.
   */
  model?: string
}

/**
 * Upper bound on the `timeoutMs` a `collect` may wait. A model that asks for
 * an hour-long blocking collect would otherwise pin the tool round-trip (which
 * runs with the plugin-tool safety net disabled) for that whole time.
 */
export const COLLECT_TIMEOUT_MAX_MS = 30 * 60 * 1000

/** Parsed `dispatch_agent` call, discriminated by mode. */
export type ParsedDispatchAgentCall =
  | { mode: "dispatch"; dispatches: NormalizedDispatch[] }
  /**
   * Await one or more backgrounded runs (Codex `wait(agent_ids, timeout)`
   * parity). Without `timeoutMs` the call blocks until every run settles.
   * With it, runs still in flight when the window closes are reported as
   * pending rather than awaited.
   */
  | { mode: "collect"; runIds: string[]; timeoutMs?: number }
  /** Stop one or more running background runs (Codex `close_agent` parity). */
  | { mode: "cancel"; runIds: string[] }
  | {
      mode: "resume"
      runId: string
      prompt: string
      toolsEnabled?: boolean
      background: boolean
      model?: string
    }
  | { mode: "error"; message: string }

const MODEL_SCHEMA = {
  type: "string",
  description:
    "Optional model id for this dispatch only (for example a faster model for a scouting task). " +
    "Defaults to the subagent's own model, else the session model.",
} as const

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
        "Detach the run and return a runId immediately. Collect the result later with `collect`.",
    },
    model: MODEL_SCHEMA,
  },
  required: ["subagentId", "prompt"],
} as const

/**
 * A runId or a list of runIds. Declared as a JSON Schema type union rather
 * than `anyOf` because several OpenAI-compatible gateways reject `anyOf` in
 * function parameters while every validator accepts a type array.
 */
const RUN_ID_LIST_SCHEMA = {
  type: ["string", "array"],
  items: { type: "string" },
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
      model: MODEL_SCHEMA,
      dispatches: {
        type: "array",
        description: "Parallel form: dispatch several subagents at once.",
        items: item,
      },
      collect: {
        ...RUN_ID_LIST_SCHEMA,
        description:
          "Await previously backgrounded run(s) by runId (one id, or a list to await several at " +
          "once). Blocks until they settle unless `timeoutMs` is set.",
      },
      timeoutMs: {
        type: "integer",
        description:
          "With `collect`: wait at most this many milliseconds. Runs still in flight when the " +
          "window closes are reported as pending (collect them again later) instead of blocking.",
      },
      cancel: {
        ...RUN_ID_LIST_SCHEMA,
        description:
          "Stop running background run(s) by runId. Partial output the run already produced is " +
          "kept and can still be collected.",
      },
      resume: {
        type: "string",
        description:
          "runId of a FINISHED run to continue: re-dispatches the same subagent with its prior " +
          "prompt + outcome as context. Requires `prompt` (the follow-up).",
      },
    },
  }
}

/** Description lists the available subagents so the model can choose well. */
function buildDescription(available: DispatchAgentAvailableSubagent[]): string {
  const base =
    "Dispatch one or more registered subagents to work on a task and return their results. " +
    "To run several subagents CONCURRENTLY, put them all in ONE call's `dispatches` array " +
    "(`{dispatches:[{subagentId, prompt}, ...]}`) — that single call fans them out in parallel and " +
    "returns once all finish. Do NOT emit several separate dispatch_agent calls to parallelize: each " +
    "call blocks until its subagent returns, so they run one after another. Use the single form " +
    "`{subagentId, prompt}` for a lone subagent. Add `background:true` to detach a run and get a " +
    'runId back immediately; `{collect:"<runId>"}` (or `{collect:["<a>","<b>"], timeoutMs}`) awaits ' +
    'detached runs, `{cancel:"<runId>"}` stops one, and `{resume:"<runId>", prompt:"<follow-up>"}` ' +
    "continues a finished run with its prior prompt + outcome as context. `model` overrides the " +
    "model for one dispatch. Write prompts that are self-contained: the subagent sees none of this " +
    "conversation, and only its final report comes back to you. Subagents cannot ask you questions, " +
    "so state assumptions and the exact deliverable (paths, identifiers, format) in the prompt."
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
  // Accept the Claude Code-style `subagent_type` as an alias for `subagentId`.
  const subagentId =
    (raw as { subagentId?: unknown }).subagentId ??
    (raw as { subagent_type?: unknown }).subagent_type
  const prompt = (raw as { prompt?: unknown }).prompt
  if (typeof subagentId !== "string" || !subagentId.trim()) return null
  if (typeof prompt !== "string" || !prompt.trim()) return null
  const model = normalizeModel((raw as { model?: unknown }).model)
  return {
    subagentId: subagentId.trim(),
    prompt,
    // Default true, the dispatched subagent normally needs tools.
    toolsEnabled: (raw as { toolsEnabled?: unknown }).toolsEnabled !== false,
    background: (raw as { background?: unknown }).background === true,
    ...(model ? { model } : {}),
  }
}

function normalizeModel(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined
  const trimmed = raw.trim()
  return trimmed ? trimmed : undefined
}

/**
 * Normalize a runId field that accepts one id or a list. Blank entries and
 * non-strings are dropped, and duplicates collapse (a model that lists the
 * same id twice should get one answer, not two). Returns `[]` when nothing
 * usable was given.
 */
function normalizeRunIds(raw: unknown): string[] {
  const items = Array.isArray(raw) ? raw : [raw]
  const out: string[] = []
  for (const item of items) {
    if (typeof item !== "string") continue
    const id = item.trim()
    if (id && !out.includes(id)) out.push(id)
  }
  return out
}

/** Clamp a `timeoutMs` to a finite, non-negative window under the cap. */
function normalizeTimeoutMs(raw: unknown): number | undefined {
  const n = typeof raw === "string" ? Number(raw) : raw
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return undefined
  return Math.min(Math.floor(n), COLLECT_TIMEOUT_MAX_MS)
}

/**
 * Normalize raw model args into a discriminated call. Precedence:
 * `cancel` > `collect` > `resume` > `dispatches` > single form. Returns an
 * `error` mode (never throws) so the handler can surface a clean tool-result
 * string.
 */
export function parseDispatchAgentArgs(args: Record<string, unknown>): ParsedDispatchAgentCall {
  if (args.cancel !== undefined && args.cancel !== null) {
    const runIds = normalizeRunIds(args.cancel)
    if (runIds.length === 0) {
      return { mode: "error", message: "dispatch_agent: `cancel` needs at least one runId." }
    }
    return { mode: "cancel", runIds }
  }

  if (args.collect !== undefined && args.collect !== null) {
    const runIds = normalizeRunIds(args.collect)
    if (runIds.length === 0) {
      return { mode: "error", message: "dispatch_agent: `collect` needs at least one runId." }
    }
    const timeoutMs = normalizeTimeoutMs(args.timeoutMs)
    return { mode: "collect", runIds, ...(timeoutMs !== undefined ? { timeoutMs } : {}) }
  }

  const resume = args.resume
  if (typeof resume === "string" && resume.trim()) {
    const prompt = args.prompt
    if (typeof prompt !== "string" || !prompt.trim()) {
      return {
        mode: "error",
        message: "dispatch_agent: `resume` requires a non-empty `prompt` (the follow-up task).",
      }
    }
    const model = normalizeModel(args.model)
    return {
      mode: "resume",
      runId: resume.trim(),
      prompt,
      ...(typeof args.toolsEnabled === "boolean" ? { toolsEnabled: args.toolsEnabled } : {}),
      background: args.background === true,
      ...(model ? { model } : {}),
    }
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
      "dispatch_agent: provide `{subagentId, prompt}`, `{dispatches:[...]}`, " +
      '`{collect:"<runId>"}`, `{cancel:"<runId>"}`, or `{resume:"<runId>", prompt}`.',
  }
}

/**
 * Shared model-facing framing for a `collect` that hit its `timeoutMs` while
 * the run was still in flight. Both shells render the same sentence so the
 * model learns one vocabulary.
 */
export function renderCollectPending(runId: string, waitedMs: number): string {
  const seconds = Math.max(0, Math.round(waitedMs / 1000))
  return (
    `Run "${runId}" is still running after ${seconds}s. Collect it again later with ` +
    `dispatch_agent({collect:"${runId}"}), or stop it with dispatch_agent({cancel:"${runId}"}).`
  )
}

/**
 * Race a collect against a wait window. Resolves `settled: false` when the
 * window closes first. The underlying collect keeps running and settles on
 * its own (its bookkeeping is idempotent, so a later collect still answers).
 * `timeoutMs` undefined means "no window": await the collect outright.
 */
export async function collectWithTimeout<T>(
  collect: () => Promise<T>,
  timeoutMs: number | undefined
): Promise<{ settled: true; value: T } | { settled: false }> {
  if (timeoutMs === undefined) return { settled: true, value: await collect() }
  let timer: ReturnType<typeof setTimeout> | undefined
  const window = new Promise<{ settled: false }>((resolve) => {
    timer = setTimeout(() => resolve({ settled: false }), timeoutMs)
  })
  const pending = collect().then((value) => ({ settled: true as const, value }))
  try {
    return await Promise.race([pending, window])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    // A collect that loses the race must never surface as an unhandled
    // rejection later. Its error is re-reported by the next explicit collect.
    pending.catch(() => undefined)
  }
}
