/**
 * Host-routed Agent-Team collaboration tools, modelled on the promoted
 * `Skill` / `SlashCommand` built-ins (`skill-builtin-tools.ts`).
 *
 * These let a teammate, DURING its own dispatch turn, collaborate with the
 * rest of the team instead of producing an isolated output: message a peer,
 * publish/read the shared-memory blackboard, open or vote in a consensus, or
 * delegate a sub-task. This is the cognia analogue of Claude Code's
 * `SendMessage` + multi-agent coordination — the layer that turns a DAG of
 * parallel task runs into a team that actually talks.
 *
 * Host-routed (renderer) because the work reaches the Zustand agent-team store
 * and the consensus / delegation / shared-memory orchestrators — TS the pure
 * `.mjs` sidecar can't import. `build-options` appends
 * {@link buildTeamCollabManifestEntries} when the session is a team dispatch AND
 * `selfInvokeTools.teamCollaboration` is on (opt-in); `plugin-tool-ipc` resolves
 * the caller's identity (which teammate / team) from the per-session
 * team-dispatch-context registry and invokes {@link runTeamBuiltinTool}.
 *
 * Every orchestrator call is reused verbatim — this module is pure glue:
 * argument shaping + identity binding + JSON-safe results for the model. The
 * PII gate on shared-memory writes lives in the orchestrator and is preserved.
 */

import type {
  CastVoteInput,
  ConsensusRequest,
  ConsensusType,
  CreateConsensusInput,
  SharedMemoryEntry,
} from "@/types/agent/agent-team"

/** Canonical tool names. Kept in one place so the manifest + router agree. */
export const TEAM_TOOL_NAMES = {
  sendMessage: "team_send_message",
  publishMemory: "team_publish_memory",
  readMemory: "team_read_memory",
  requestConsensus: "team_request_consensus",
  vote: "team_vote",
  delegate: "team_delegate",
  listMembers: "team_list_members",
} as const

/** Synthetic plugin id tagging the promoted team-collaboration manifest entries. */
export const TEAM_BUILTIN_PLUGIN_ID = "cognia-team-builtin"

const ALL_TEAM_TOOL_NAMES: ReadonlySet<string> = new Set(Object.values(TEAM_TOOL_NAMES))

/** Is this tool name one of the promoted team-collaboration built-ins? */
export function isTeamBuiltinTool(name: string): boolean {
  return ALL_TEAM_TOOL_NAMES.has(name)
}

export interface TeamBuiltinManifestEntry {
  name: string
  description: string
  jsonSchema: Record<string, unknown>
  pluginId: string
}

/** Identity of the teammate making the call, resolved from the session registry. */
export interface TeamToolCaller {
  teamId: string
  teammateId: string
  teammateName: string
  runId?: string
}

/**
 * Injectable orchestrator seam (defaults wire the real store-backed
 * orchestrators). Mirrors `SkillToolRunDeps` so unit tests can run without the
 * Zustand store or the heavy delegation runtime.
 */
export interface TeamToolDeps {
  addMessage: (input: {
    teamId: string
    senderId: string
    type: "direct" | "broadcast"
    content: string
    recipientId?: string
  }) => void
  publishEntry: (input: {
    teamId: string
    key: string
    value: unknown
    writer: { id: string; name: string }
    tags?: string[]
    readableBy?: string[]
  }) => SharedMemoryEntry
  listMemory: (teamId: string, readerId: string) => SharedMemoryEntry[]
  createConsensus: (input: CreateConsensusInput) => ConsensusRequest
  castVote: (input: CastVoteInput) => ConsensusRequest
  delegate: (input: {
    target: "background" | "external" | "team"
    sourceTeamId: string
    sourceTaskId: string
    reason: string
    prompt?: string
    systemPrompt?: string
    targetAgentId?: string
    targetTeamId?: string
    ultracode?: boolean
  }) => { id: string; status: string }
  listMembers: (teamId: string) => Array<{ id: string; name: string; role: string }>
}

const SEND_MESSAGE_SCHEMA = {
  type: "object",
  properties: {
    content: { type: "string", description: "The message body." },
    to: {
      type: "string",
      description:
        "Recipient teammate id (use team_list_members). Omit to broadcast to the whole team.",
    },
  },
  required: ["content"],
} as const

const PUBLISH_MEMORY_SCHEMA = {
  type: "object",
  properties: {
    key: { type: "string", description: "Blackboard key, e.g. `decision:db-choice`." },
    value: { type: "string", description: "The value to share (PII-gated)." },
    tags: { type: "array", items: { type: "string" }, description: "Optional filter tags." },
  },
  required: ["key", "value"],
} as const

const READ_MEMORY_SCHEMA = {
  type: "object",
  properties: {
    keys: {
      type: "array",
      items: { type: "string" },
      description: "Optional key filter. Omit to read every entry you may access.",
    },
  },
} as const

const REQUEST_CONSENSUS_SCHEMA = {
  type: "object",
  properties: {
    question: { type: "string", description: "The decision to put to the team." },
    options: {
      type: "array",
      items: { type: "string" },
      description: "Two or more options the team votes between.",
    },
    type: {
      type: "string",
      enum: ["majority", "supermajority", "unanimous", "weighted", "lead_override"],
      description: "Voting rule (default majority).",
    },
  },
  required: ["question", "options"],
} as const

const VOTE_SCHEMA = {
  type: "object",
  properties: {
    consensusId: { type: "string", description: "The open consensus id." },
    optionIndex: { type: "number", description: "Zero-based index of your chosen option." },
    reasoning: { type: "string", description: "Optional short rationale." },
  },
  required: ["consensusId", "optionIndex"],
} as const

const DELEGATE_SCHEMA = {
  type: "object",
  properties: {
    target: {
      type: "string",
      enum: ["background", "external", "team"],
      description: "Where to delegate: a background agent, an external CLI agent, or another team.",
    },
    reason: { type: "string", description: "Why this work is being delegated." },
    prompt: { type: "string", description: "Task prompt (required for `background`)." },
    targetAgentId: { type: "string", description: "External agent id (required for `external`)." },
    targetTeamId: { type: "string", description: "Target team id (required for `team`)." },
    ultracode: { type: "boolean", description: "Force ultracode on a `team` delegation." },
  },
  required: ["target", "reason"],
} as const

const LIST_MEMBERS_SCHEMA = { type: "object", properties: {} } as const

/**
 * Manifest entries for the team-collaboration tools. Returned to `build-options`
 * to append to `pluginTools` for a team dispatch session (opt-in).
 */
export function buildTeamCollabManifestEntries(): TeamBuiltinManifestEntry[] {
  const entry = (
    name: string,
    description: string,
    jsonSchema: Record<string, unknown>
  ): TeamBuiltinManifestEntry => ({
    name,
    description,
    jsonSchema,
    pluginId: TEAM_BUILTIN_PLUGIN_ID,
  })
  return [
    entry(
      TEAM_TOOL_NAMES.sendMessage,
      "Send a message to a teammate (or broadcast to the whole team).",
      SEND_MESSAGE_SCHEMA as unknown as Record<string, unknown>
    ),
    entry(
      TEAM_TOOL_NAMES.publishMemory,
      "Publish a value to the team's shared-memory blackboard so teammates can read it.",
      PUBLISH_MEMORY_SCHEMA as unknown as Record<string, unknown>
    ),
    entry(
      TEAM_TOOL_NAMES.readMemory,
      "Read entries from the team's shared-memory blackboard.",
      READ_MEMORY_SCHEMA as unknown as Record<string, unknown>
    ),
    entry(
      TEAM_TOOL_NAMES.requestConsensus,
      "Open a consensus vote so the team can decide between options.",
      REQUEST_CONSENSUS_SCHEMA as unknown as Record<string, unknown>
    ),
    entry(
      TEAM_TOOL_NAMES.vote,
      "Cast your vote on an open consensus.",
      VOTE_SCHEMA as unknown as Record<string, unknown>
    ),
    entry(
      TEAM_TOOL_NAMES.delegate,
      "Delegate a sub-task to a background agent, an external agent, or another team.",
      DELEGATE_SCHEMA as unknown as Record<string, unknown>
    ),
    entry(
      TEAM_TOOL_NAMES.listMembers,
      "List the teammates on your team (id, name, role) — use before messaging or delegating.",
      LIST_MEMBERS_SCHEMA as unknown as Record<string, unknown>
    ),
  ]
}

/** Lazy default deps wiring the real store-backed orchestrators. */
export async function defaultTeamToolDeps(): Promise<TeamToolDeps> {
  const [{ useAgentTeamStore }, sharedMemory, consensus, delegation] = await Promise.all([
    import("@/stores/agent/agent-team-store"),
    import("@/lib/ai/agent/team/shared-memory-orchestrator"),
    import("@/lib/ai/agent/team/consensus-orchestrator"),
    import("@/lib/ai/agent/team/delegation-orchestrator"),
  ])
  return {
    addMessage: (input) =>
      void useAgentTeamStore.getState().addMessage({
        teamId: input.teamId,
        senderId: input.senderId,
        type: input.type,
        content: input.content,
        ...(input.recipientId ? { recipientId: input.recipientId } : {}),
      }),
    publishEntry: (input) => sharedMemory.publishEntry(input),
    listMemory: (teamId, readerId) =>
      sharedMemory.selectSharedMemoryEntriesForReader(
        teamId,
        readerId
      )(useAgentTeamStore.getState()),
    createConsensus: (input) => consensus.createConsensus(input),
    castVote: (input) => consensus.castVote(input),
    delegate: (input) => {
      if (input.target === "external") {
        const rec = delegation.delegateToExternal({
          sourceTeamId: input.sourceTeamId,
          sourceTaskId: input.sourceTaskId,
          targetAgentId: input.targetAgentId ?? "",
          reason: input.reason,
        })
        return { id: rec.id, status: rec.status }
      }
      if (input.target === "team") {
        const { delegation: rec } = delegation.delegateToTeam({
          sourceTeamId: input.sourceTeamId,
          sourceTaskId: input.sourceTaskId,
          targetTeamId: input.targetTeamId ?? "",
          reason: input.reason,
          ...(input.ultracode !== undefined ? { ultracode: input.ultracode } : {}),
        })
        return { id: rec.id, status: rec.status }
      }
      const { delegation: rec } = delegation.delegateToBackground({
        sourceTeamId: input.sourceTeamId,
        sourceTaskId: input.sourceTaskId,
        prompt: input.prompt ?? input.reason,
        ...(input.systemPrompt ? { systemPrompt: input.systemPrompt } : {}),
        reason: input.reason,
      })
      return { id: rec.id, status: rec.status }
    },
    listMembers: (teamId) =>
      Object.values(useAgentTeamStore.getState().teammates)
        .filter((t) => t.teamId === teamId)
        .map((t) => ({ id: t.id, name: t.name, role: t.role })),
  }
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : ""
}

/**
 * Execute a team-collaboration tool host-side. `caller` binds the call to the
 * teammate that issued it (resolved from the session registry in
 * plugin-tool-ipc). Returns a JSON-safe value / string the model reads back.
 * Never throws — every failure is returned as an `Error: …` string so a tool
 * mishap can't abort the teammate's turn.
 */
export async function runTeamBuiltinTool(
  name: string,
  args: Record<string, unknown>,
  caller: TeamToolCaller,
  deps?: TeamToolDeps
): Promise<unknown> {
  if (!isTeamBuiltinTool(name)) return `Error: unknown team tool: ${name}`
  const d = deps ?? (await defaultTeamToolDeps())
  const writer = { id: caller.teammateId, name: caller.teammateName }
  try {
    switch (name) {
      case TEAM_TOOL_NAMES.sendMessage: {
        const content = asString(args.content).trim()
        if (!content) return "Error: team_send_message requires non-empty `content`."
        const to = asString(args.to).trim()
        d.addMessage({
          teamId: caller.teamId,
          senderId: caller.teammateId,
          type: to ? "direct" : "broadcast",
          content,
          ...(to ? { recipientId: to } : {}),
        })
        return to ? `Message sent to ${to}.` : "Message broadcast to the team."
      }
      case TEAM_TOOL_NAMES.publishMemory: {
        const key = asString(args.key).trim()
        if (!key) return "Error: team_publish_memory requires a `key`."
        try {
          const entry = d.publishEntry({
            teamId: caller.teamId,
            key,
            value: args.value,
            writer,
            ...(Array.isArray(args.tags) ? { tags: args.tags.map(String) } : {}),
          })
          return `Published "${key}" (v${entry.version}).`
        } catch (err) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`
        }
      }
      case TEAM_TOOL_NAMES.readMemory: {
        const entries = d.listMemory(caller.teamId, caller.teammateId)
        const filter = Array.isArray(args.keys) ? new Set(args.keys.map(String)) : undefined
        const picked = (filter ? entries.filter((e) => filter.has(e.key)) : entries).map((e) => ({
          key: e.key,
          value: e.value,
          writerName: e.writerName,
        }))
        return picked.length > 0 ? picked : "No readable shared-memory entries."
      }
      case TEAM_TOOL_NAMES.requestConsensus: {
        const question = asString(args.question).trim()
        const options = Array.isArray(args.options) ? args.options.map(String) : []
        if (!question || options.length < 2) {
          return "Error: team_request_consensus requires a `question` and at least two `options`."
        }
        const created = d.createConsensus({
          teamId: caller.teamId,
          initiatorId: caller.teammateId,
          question,
          options,
          ...(typeof args.type === "string" ? { type: args.type as ConsensusType } : {}),
        })
        return `Consensus opened (id=${created.id}). Teammates can vote with team_vote.`
      }
      case TEAM_TOOL_NAMES.vote: {
        const consensusId = asString(args.consensusId).trim()
        const optionIndex = Number(args.optionIndex)
        if (!consensusId || !Number.isInteger(optionIndex)) {
          return "Error: team_vote requires `consensusId` and an integer `optionIndex`."
        }
        const after = d.castVote({
          consensusId,
          voterId: caller.teammateId,
          optionIndex,
          ...(typeof args.reasoning === "string" ? { reasoning: args.reasoning } : {}),
        })
        return after.status === "resolved"
          ? `Vote recorded — consensus resolved (option ${(after.winningOption ?? 0) + 1}).`
          : "Vote recorded — consensus still open."
      }
      case TEAM_TOOL_NAMES.delegate: {
        const target = asString(args.target)
        if (target !== "background" && target !== "external" && target !== "team") {
          return "Error: team_delegate `target` must be background | external | team."
        }
        const reason = asString(args.reason).trim() || "delegated by teammate"
        const rec = d.delegate({
          target,
          sourceTeamId: caller.teamId,
          sourceTaskId: caller.runId ?? `adhoc:${caller.teammateId}`,
          reason,
          ...(typeof args.prompt === "string" ? { prompt: args.prompt } : {}),
          ...(typeof args.systemPrompt === "string" ? { systemPrompt: args.systemPrompt } : {}),
          ...(typeof args.targetAgentId === "string" ? { targetAgentId: args.targetAgentId } : {}),
          ...(typeof args.targetTeamId === "string" ? { targetTeamId: args.targetTeamId } : {}),
          ...(typeof args.ultracode === "boolean" ? { ultracode: args.ultracode } : {}),
        })
        return `Delegated to ${target} (id=${rec.id}, status=${rec.status}).`
      }
      case TEAM_TOOL_NAMES.listMembers: {
        return d.listMembers(caller.teamId)
      }
      /* istanbul ignore next -- unreachable: isTeamBuiltinTool() filters non-team names before the switch */
      default:
        return `Error: unhandled team tool: ${name}`
    }
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`
  }
}
