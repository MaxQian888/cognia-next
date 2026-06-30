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
import {
  canSendMessage,
  describeSuppressedMessage,
  type RecentMessage,
} from "@/lib/ai/agent/team/message-guard"

/**
 * System-prompt fragment appended for a team dispatch session (alongside the
 * collaboration tool manifest). Teaches the two conventions the message guard and the
 * `<info_for_agent>` UI strip rely on. Kept here so the prompt + the tools agree.
 */
export const TEAM_MESSAGING_PROTOCOL = `TEAM MESSAGING PROTOCOL:
- Do NOT send idle/acknowledgement-only messages ("ok", "understood", "waiting for tasks", "收到", "明白"). Stay silent unless you have findings, a decision, a blocker, or a question. Such messages are dropped.
- Do not repeat a message a teammate already has, and do not rapid-fire the same teammate — batch your updates.
- Record durable findings, decisions, and results as a task comment (task_add_comment) — that is what the operator reads on the board; direct messages are ephemeral.
- If you must pass operational instructions to a teammate that the human operator should NOT see, wrap ONLY that hidden part in <info_for_agent> ... </info_for_agent>. Keep normal human-readable coordination outside the block. NEVER use this block in a message addressed to the user.`

/** How far back the message guard windows recent team messages (ms). */
const MESSAGE_GUARD_WINDOW_MS = 60_000

/** Canonical tool names. Kept in one place so the manifest + router agree. */
export const TEAM_TOOL_NAMES = {
  sendMessage: "team_send_message",
  publishMemory: "team_publish_memory",
  readMemory: "team_read_memory",
  requestConsensus: "team_request_consensus",
  vote: "team_vote",
  delegate: "team_delegate",
  listMembers: "team_list_members",
  addTaskComment: "task_add_comment",
  getTask: "task_get",
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
  /** Recent team messages (epoch-ms `createdAt`), windowed by the default impl. */
  recentMessages: (teamId: string) => RecentMessage[]
  addTaskComment: (input: {
    taskId: string
    authorId: string
    text: string
    attachments?: Array<{
      name: string
      kind: "artifact" | "file" | "link"
      ref: string
      mimeType?: string
      sizeBytes?: number
    }>
  }) => { id: string } | null
  getTask: (taskId: string) => {
    id: string
    title: string
    status: string
    description: string
    comments: Array<{ authorName: string; text: string; createdAt: string }>
  } | null
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

const ADD_TASK_COMMENT_SCHEMA = {
  type: "object",
  properties: {
    taskId: { type: "string", description: "The task to comment on." },
    content: {
      type: "string",
      description:
        "Your finding, decision, blocker, or result (markdown). This is the durable, board-visible record.",
    },
    attachments: {
      type: "array",
      description: "Optional references the operator can open.",
      items: {
        type: "object",
        properties: {
          name: { type: "string", description: "Display name." },
          kind: {
            type: "string",
            enum: ["artifact", "file", "link"],
            description: "What `ref` points at.",
          },
          ref: { type: "string", description: "Artifact id, workspace-relative path, or URL." },
        },
        required: ["name", "kind", "ref"],
      },
    },
  },
  required: ["taskId", "content"],
} as const

const GET_TASK_SCHEMA = {
  type: "object",
  properties: {
    taskId: { type: "string", description: "The task id to fetch (includes its comment thread)." },
  },
  required: ["taskId"],
} as const

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
    entry(
      TEAM_TOOL_NAMES.addTaskComment,
      "Record a finding, decision, blocker, or result on a task. This is the durable, board-visible delivery channel — prefer it over ephemeral direct messages for anything the operator should see.",
      ADD_TASK_COMMENT_SCHEMA as unknown as Record<string, unknown>
    ),
    entry(
      TEAM_TOOL_NAMES.getTask,
      "Fetch a task by id, including its full comment thread.",
      GET_TASK_SCHEMA as unknown as Record<string, unknown>
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
        const { delegation: rec } = delegation.delegateToExternal({
          sourceTeamId: input.sourceTeamId,
          sourceTaskId: input.sourceTaskId,
          targetAgentId: input.targetAgentId ?? "",
          prompt: input.prompt ?? input.reason,
          ...(input.systemPrompt ? { systemPrompt: input.systemPrompt } : {}),
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
    recentMessages: (teamId) => {
      const cutoff = Date.now() - MESSAGE_GUARD_WINDOW_MS
      return useAgentTeamStore
        .getState()
        .getTeamMessages(teamId)
        .filter((m) => m.type === "direct" || m.type === "broadcast")
        .map((m) => ({
          senderId: m.senderId,
          ...(m.recipientId ? { recipientId: m.recipientId } : {}),
          content: m.content,
          createdAt: m.timestamp instanceof Date ? m.timestamp.getTime() : Number(m.timestamp) || 0,
        }))
        .filter((m) => m.createdAt >= cutoff)
    },
    addTaskComment: (input) => {
      const comment = useAgentTeamStore.getState().addTaskComment({
        taskId: input.taskId,
        authorId: input.authorId,
        text: input.text,
        ...(input.attachments && input.attachments.length > 0
          ? { attachments: input.attachments }
          : {}),
      })
      return comment ? { id: comment.id } : null
    },
    getTask: (taskId) => {
      const task = useAgentTeamStore.getState().tasks[taskId]
      if (!task) return null
      return {
        id: task.id,
        title: task.title,
        status: task.status,
        description: task.description,
        comments: (task.comments ?? []).map((c) => ({
          authorName: c.authorName,
          text: c.text,
          createdAt: c.createdAt instanceof Date ? c.createdAt.toISOString() : String(c.createdAt),
        })),
      }
    },
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
        // Anti-storm guard: drop idle/ack-only chatter, duplicates, ping-pong, and
        // rate-floods before they reach the mailbox. The store is the source of truth
        // for the recent-message window. result_share deliverables never come here.
        const decision = canSendMessage({
          senderId: caller.teammateId,
          ...(to ? { recipientId: to } : {}),
          content,
          now: Date.now(),
          recentMessages: d.recentMessages(caller.teamId),
        })
        if (!decision.allow) {
          return describeSuppressedMessage(decision.reason as Exclude<typeof decision.reason, "ok">)
        }
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
      case TEAM_TOOL_NAMES.addTaskComment: {
        const taskId = asString(args.taskId).trim()
        const content = asString(args.content).trim()
        if (!taskId) return "Error: task_add_comment requires a `taskId`."
        if (!content) return "Error: task_add_comment requires non-empty `content`."
        const attachments = Array.isArray(args.attachments)
          ? args.attachments
              .filter((a): a is Record<string, unknown> => !!a && typeof a === "object")
              .map((a): { name: string; kind: "artifact" | "file" | "link"; ref: string } => ({
                name: asString(a.name).trim() || "attachment",
                kind: a.kind === "artifact" || a.kind === "link" ? a.kind : "file",
                ref: asString(a.ref).trim(),
              }))
              .filter((a) => a.ref)
          : undefined
        const res = d.addTaskComment({
          taskId,
          authorId: caller.teammateId,
          text: content,
          ...(attachments && attachments.length > 0 ? { attachments } : {}),
        })
        return res
          ? `Comment added to ${taskId} (id=${res.id}).`
          : `Error: could not add comment — task ${taskId} not found.`
      }
      case TEAM_TOOL_NAMES.getTask: {
        const taskId = asString(args.taskId).trim()
        if (!taskId) return "Error: task_get requires a `taskId`."
        const task = d.getTask(taskId)
        return task ?? `Error: task ${taskId} not found.`
      }
      /* istanbul ignore next -- unreachable: isTeamBuiltinTool() filters non-team names before the switch */
      default:
        return `Error: unhandled team tool: ${name}`
    }
  } catch (err) {
    return `Error: ${err instanceof Error ? err.message : String(err)}`
  }
}
