"use client"

// Plan-mode → tasks bridge. Translates `tool_use` blocks emitted by the
// Claude Agent SDK in plan mode into mutations on `useAgentTeamStore` so
// the workspace `tasks` panel surfaces tasks the agent itself proposes.
//
// Recognised tool names:
//   • TodoWrite — full todo list snapshot (`{ todos: [{ content, status,
//     activeForm }] }`). Treated as authoritative: anything missing on the
//     subsequent call is marked `cancelled`.
//   • TaskCreate — single-shot create (`{ content, activeForm }`).
//   • TaskUpdate — single-shot update (`{ id, status }`).
//   • TaskList — alias of TodoWrite (`{ tasks: [...] }`).
//   • ExitPlanMode — Phase 1 leaves rendering to the existing tool-* path
//     in `applySdkEvent`; this bridge takes no store action.
//
// For non-team chat sessions we route into a synthetic team identified by
// `solo:<sessionId>`, created on first emit. The `<PlanModeTasksSheet>` in
// the chat header reads the same id back. Phase 1 is in-memory only —
// reload wipes the synthetic team. Persistence is a Phase 2 concern.

import type { SDKAssistantMessage, SDKMessage, BetaToolUseBlock } from "@/lib/claude/types"
import { useAgentTeamStore } from "@/stores/agent/agent-team-store"
import type { AgentTeam, AgentTeamTask, TeamTaskStatus } from "@/types/agent/agent-team"

const SOLO_TEAM_PREFIX = "solo:"

/** Resolve the synthetic team id for a non-team chat session. */
export function soloTeamId(sessionId: string): string {
  return `${SOLO_TEAM_PREFIX}${sessionId}`
}

/**
 * Map the SDK's status vocabulary (and a few legacy aliases) onto
 * `TeamTaskStatus`. Unknown values bias toward `pending`; the bridge prefers
 * to under-translate rather than misrepresent state.
 */
export function mapStatus(sdkStatus: string | undefined | null): TeamTaskStatus {
  switch (sdkStatus) {
    case "in_progress":
    case "running":
    case "active":
      return "in_progress"
    case "completed":
    case "done":
      return "completed"
    case "cancelled":
    case "canceled":
      return "cancelled"
    case "failed":
    case "error":
      return "failed"
    case "blocked":
      return "blocked"
    case "review":
      return "review"
    case "pending":
    default:
      return "pending"
  }
}

interface TodoEntry {
  content: string
  status: string
  activeForm?: string
}

/** Defensive parse for a TodoWrite-style payload's `todos` array. */
export function parseTodos(input: unknown, key: "todos" | "tasks" = "todos"): TodoEntry[] | null {
  if (!input || typeof input !== "object") return null
  const list = (input as Record<string, unknown>)[key]
  if (!Array.isArray(list)) return null
  const out: TodoEntry[] = []
  for (const t of list) {
    if (!t || typeof t !== "object") continue
    const content = (t as { content?: unknown }).content ?? (t as { title?: unknown }).title
    const status = (t as { status?: unknown }).status
    const activeForm = (t as { activeForm?: unknown }).activeForm
    if (typeof content !== "string" || !content.trim()) continue
    out.push({
      content: content.trim(),
      status: typeof status === "string" ? status : "pending",
      activeForm: typeof activeForm === "string" ? activeForm : undefined,
    })
  }
  return out
}

/**
 * Ensure a synthetic "solo team" exists for a chat session id. No-op when
 * `teamId` already references a team in the store. We use `upsertTeam`
 * directly rather than `createTeam` to avoid spinning up a Lead teammate
 * and the consequent UI noise — the synthetic team is task-only.
 */
function ensureSoloTeam(teamId: string): void {
  const store = useAgentTeamStore.getState()
  if (store.teams[teamId]) return
  if (!teamId.startsWith(SOLO_TEAM_PREFIX)) return
  const sessionId = teamId.slice(SOLO_TEAM_PREFIX.length)
  const team: AgentTeam = {
    id: teamId,
    name: "Plan-mode tasks",
    description: "Tasks emitted by the SDK in plan mode for this chat.",
    task: "",
    status: "idle",
    config: store.defaultConfig,
    selectedExecutionPattern: store.defaultConfig.preferredExecutionPattern,
    leadId: "",
    teammateIds: [],
    taskIds: [],
    messageIds: [],
    progress: 0,
    totalTokenUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
    createdAt: new Date(),
    sessionId,
  }
  store.upsertTeam(team)
}

/**
 * Diff `todos` against existing team tasks (matched by title) and apply
 * create / update / cancel. The SDK's TodoWrite emits the full list per
 * call, so:
 *   • title in both lists → patch only on real change (status/description)
 *   • title only in todos → create
 *   • title only in existing → mark cancelled (unless already done/cancelled)
 */
export function syncTodos(teamId: string, todos: TodoEntry[]): void {
  ensureSoloTeam(teamId)
  const store = useAgentTeamStore.getState()
  const existing = store.getTeamTasks(teamId)
  const byTitle = new Map<string, AgentTeamTask>()
  for (const t of existing) byTitle.set(t.title, t)

  const seenTitles = new Set<string>()
  for (const todo of todos) {
    seenTitles.add(todo.content)
    const status = mapStatus(todo.status)
    const desc = todo.activeForm ?? todo.content
    const prior = byTitle.get(todo.content)
    if (prior) {
      const changed = prior.status !== status || prior.description !== desc
      if (changed) store.updateTask(prior.id, { status, description: desc })
    } else {
      store.createTask({
        teamId,
        title: todo.content,
        description: desc,
        priority: "normal",
      })
      if (status !== "pending") {
        // Re-read to find the freshly-created row's id; createTask returns
        // the row but we use the same get-state pattern for symmetry with
        // the update path.
        const fresh = useAgentTeamStore
          .getState()
          .getTeamTasks(teamId)
          .find((t) => t.title === todo.content)
        if (fresh) store.updateTask(fresh.id, { status })
      }
    }
  }

  for (const t of existing) {
    if (seenTitles.has(t.title)) continue
    if (t.status === "completed" || t.status === "cancelled") continue
    store.updateTask(t.id, { status: "cancelled" })
  }
}

/** Public entry — inspect an SDK event and forward plan-mode tool calls. */
export function applyPlanModeBridge(
  evt: SDKMessage,
  sessionId: string,
  teamId: string | undefined
): void {
  if (!evt || evt.type !== "assistant") return
  const message = (evt as SDKAssistantMessage).message
  if (!message?.content || !Array.isArray(message.content)) return

  const targetTeamId = teamId ?? soloTeamId(sessionId)

  for (const block of message.content) {
    const type = (block as { type?: string }).type
    if (type !== "tool_use") continue
    const tu = block as BetaToolUseBlock
    switch (tu.name) {
      case "TodoWrite": {
        const todos = parseTodos(tu.input, "todos")
        if (todos) syncTodos(targetTeamId, todos)
        break
      }
      case "TaskList": {
        const todos = parseTodos(tu.input, "tasks") ?? parseTodos(tu.input, "todos")
        if (todos) syncTodos(targetTeamId, todos)
        break
      }
      case "TaskCreate": {
        const content = (tu.input as { content?: unknown }).content
        const activeForm = (tu.input as { activeForm?: unknown }).activeForm
        if (typeof content === "string" && content.trim()) {
          ensureSoloTeam(targetTeamId)
          useAgentTeamStore.getState().createTask({
            teamId: targetTeamId,
            title: content.trim(),
            description:
              typeof activeForm === "string" && activeForm.trim()
                ? activeForm.trim()
                : content.trim(),
            priority: "normal",
          })
        }
        break
      }
      case "TaskUpdate": {
        const id = (tu.input as { id?: unknown }).id
        const status = (tu.input as { status?: unknown }).status
        if (typeof id === "string" && typeof status === "string") {
          useAgentTeamStore.getState().updateTask(id, { status: mapStatus(status) })
        }
        break
      }
      case "ExitPlanMode": {
        // Phase 1: rendering the plan body falls through to the existing
        // tool-* renderer path in `applySdkEvent`. The bridge intentionally
        // takes no store action so the chat shows the plan as a regular
        // tool call.
        break
      }
      default:
        // Unknown tool name — silent no-op so the chat renderer still emits
        // a generic tool block, avoiding any data loss.
        break
    }
  }
}

export const __testing__ = { ensureSoloTeam, SOLO_TEAM_PREFIX }
