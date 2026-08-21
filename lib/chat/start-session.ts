import { createSession, updateSession } from "@/lib/db/sessions"
import { useChatStore } from "@/stores/chat"
import { useProjectStore } from "@/stores/project/project-store"
import { useUIStore } from "@/stores/ui"
import { emitSystemBusEvent, SystemEvents } from "@/lib/plugin/messaging/message-bus"
import type { ChatSession } from "@cognia/agent-config-types"
import { primaryRootOf } from "@/lib/workspace/roots"
import { createSessionExecutionContext } from "@/lib/task-workspace/session-execution-context"
import {
  createManagedWorkspaceContext,
  materializeManagedWorkspace,
} from "@/lib/task-workspace/managed-workspace"

/** The subset of a session a caller may seed when starting a conversation. */
export type NewSessionInput = Partial<
  Pick<
    ChatSession,
    | "title"
    | "model"
    | "systemPrompt"
    | "workingDir"
    | "kind"
    | "characterId"
    | "teamId"
    | "executionContext"
    | "sdkSessionId"
  >
>

/**
 * The single path that starts a conversation. Every entry point — welcome CTA,
 * starter cards, channel-list "+", command palette, native menu / Cmd+N, tray,
 * CLI `--new-chat` — funnels through here so "new chat" means one thing.
 *
 * Beyond writing the Dexie row it owns the side effects a session is useless
 * without: workspace linking (else the session is invisible in the scoped
 * list), activation, revealing the row in the conversation list, and the
 * plugin-bus announcement.
 *
 * Passing no input is the deliberate "quick start" path: `createSession`
 * auto-applies the default preset when no character/team/model/prompt/dir is
 * given, so a conversation is usable without picking a character first.
 */
export async function startNewSession(partial?: NewSessionInput): Promise<ChatSession> {
  let session = await createSession(partial)

  // Auto-link to the active workspace so it groups under that project
  // (persisted via `project.sessionIds`). No-op when no workspace is active.
  const { activeProjectId, addSessionToProject, projects } = useProjectStore.getState()
  if (activeProjectId) addSessionToProject(activeProjectId, session.id)

  // Every conversation has one durable workspace identity. Active-project
  // chats bind to that Project; projectless Quick Chats receive a managed,
  // portable identity and materialize a device-local root when desktop APIs
  // are available. Web/mobile receivers keep the explicit missing state.
  if (!partial?.executionContext) {
    const project = activeProjectId
      ? projects.find((candidate) => candidate.id === activeProjectId)
      : undefined
    const root = project ? primaryRootOf(project) : undefined
    const executionContext =
      project && root
        ? createSessionExecutionContext({
            sessionId: session.id,
            projectId: project.id,
            projectRoot: root.path,
            rootId: root.id,
            environmentId: project.defaultEnvironmentId,
            requestedLocation: "local",
            isGitRepository: false,
            now: Date.now(),
          })
        : createManagedWorkspaceContext(session.id, Date.now())
    await updateSession(session.id, { executionContext })
    session = { ...session, executionContext }
    if (executionContext.workspaceBinding?.kind === "managed") {
      try {
        const materialized = await materializeManagedWorkspace(session.id)
        session = { ...session, executionContext: materialized }
      } catch {
        // The durable identity is still valid. This device must explicitly
        // rebind/import before execution, rather than guessing a directory.
      }
    }
  }

  useChatStore.getState().setActiveSession(session.id)
  // Fourth side effect: the conversation list has to *show* it. Activation puts
  // the conversation in the pane, but the sidebar keeps its own narrowing —
  // the Archived view, a search still in the field, a quick filter from
  // yesterday — and any of those leaves the new row off screen. The list undoes
  // only what is actually hiding it (`use-conversation-reveal.ts`).
  useUIStore.getState().requestConversationReveal(session.id)
  emitSystemBusEvent(SystemEvents.SESSION_CREATED, { sessionId: session.id })

  return session
}
