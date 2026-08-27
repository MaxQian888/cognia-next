import { createSession, updateSession } from "@/lib/db/sessions"
import { useChatStore } from "@/stores/chat"
import { useProjectStore } from "@/stores/project/project-store"
import { useUIStore } from "@/stores/ui"
import { emitSystemBusEvent, SystemEvents } from "@/lib/plugin/messaging/message-bus"
import type { ChatSession } from "@cognia/agent-config-types"
import type { SessionExecutionLocation, SessionWorkspaceBaseSpec } from "@/types/execution-context"
import {
  defaultEnsureDefaultWorkspaceDeps,
  ensureDefaultWorkspace,
} from "@/lib/workspace/ensure-default-workspace"
import { primaryRootOf } from "@/lib/workspace/roots"
import { loadDeclaredWorkspace } from "@/lib/workspace/repo-declared"
import { useSettingsStore } from "@/stores/settings"
import { isTauri } from "@/lib/tauri"
import { createSessionExecutionContext } from "@/lib/task-workspace/session-execution-context"
import {
  createManagedWorkspaceContext,
  materializeManagedWorkspace,
} from "@/lib/task-workspace/managed-workspace"

/**
 * The subset of a session a caller may seed when starting a conversation.
 *
 * `characterId` / `teamId` / `squadId` are the three identity columns and they
 * travel together: a caller that can name the persona must be able to name the
 * executor too, or "start this conversation the way that one runs" is only ever
 * two-thirds true. `projectId` is here for the same reason — an entry point
 * that already knows which workspace the conversation belongs to (a template, a
 * scheduled run, an issue) should not have to switch the UI-active workspace to
 * say so.
 */
type SessionSeed = Partial<
  Pick<
    ChatSession,
    | "title"
    | "model"
    | "systemPrompt"
    | "workingDir"
    | "kind"
    | "characterId"
    | "teamId"
    | "squadId"
    | "projectId"
    | "executionContext"
    | "sdkSessionId"
  >
>

export interface NewSessionInput extends SessionSeed {
  /** New-chat execution choice. Persisted on the Project after creation. */
  executionLocation?: SessionExecutionLocation
  /** Requested isolation base. Ignored for Local execution. */
  executionBase?: SessionWorkspaceBaseSpec
}

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
  const { executionLocation, executionBase, ...sessionSeed } = partial ?? {}

  // Name the owning workspace explicitly instead of letting `createSession`
  // resolve it. `resolveScopeProjectId` reads the PERSISTED
  // `AppSettings.activeProjectId`, which lags the store by one async write, so
  // a conversation started right after switching workspaces could be stamped
  // with the one the user just left. The store is the truth at the moment the
  // user clicked "new chat".
  const store = useProjectStore.getState()
  // An explicit `projectId` wins: the caller named the workspace, and a caller
  // that names one knows something the UI pointer does not.
  const seededProjectId = sessionSeed.projectId ?? store.activeProjectId ?? undefined
  let session = await createSession(
    seededProjectId ? { ...sessionSeed, projectId: seededProjectId } : sessionSeed
  )

  // Never null: with no active workspace `createSession` adopts (or creates)
  // Default, so the row is always attributed. Everything below binds to THAT
  // workspace rather than to the UI-active pointer.
  let ownerProjectId = session.projectId ?? seededProjectId ?? null
  if (ownerProjectId) store.addSessionToProject(ownerProjectId, session.id)

  // The store can be a step behind Dexie here — `resolveScopeProjectId` may
  // have just created Default in the database. Load once so the workspace the
  // row names is actually visible before the execution context is derived from
  // it; `load()` is a no-op once hydrated.
  if (ownerProjectId && !store.projects.some((p) => p.id === ownerProjectId)) {
    await store.load().catch(() => undefined)
  }
  const { projects, updateProject } = useProjectStore.getState()

  // Every conversation has one durable workspace identity. A workspace with a
  // root binds to that Project; a rootless one (the Default workspace before
  // the user has opened or created anything) has no directory to bind to, so it
  // receives a managed, portable identity and materializes a device-local root
  // where desktop APIs exist. Web/mobile receivers keep the explicit missing
  // state rather than guessing a directory.
  if (!partial?.executionContext) {
    let project = ownerProjectId
      ? projects.find((candidate) => candidate.id === ownerProjectId)
      : undefined
    let root = project ? primaryRootOf(project) : undefined
    // Nothing on this device has a directory yet — the Default workspace ships
    // with `roots: []` and the setup line is skippable. Provision one rather
    // than handing the agent a workspace it cannot touch a file in. Off-desktop
    // this answers `unavailable` and the managed identity below still applies.
    if (!root) {
      const ensured = await ensureDefaultWorkspace(
        defaultEnsureDefaultWorkspaceDeps(useSettingsStore.getState().settings?.projectsRoot)
      ).catch(() => null)
      // `created` ONLY, never `existing`. `ensureDefaultWorkspace` answers
      // "existing" for ANY rooted workspace on the device, which — since we are
      // here precisely because the owner has no root — is by construction some
      // OTHER workspace, and one nothing activated. Re-attributing to it would
      // move the conversation out of the workspace the user is looking at and
      // produce the very ADR-0144 divergence the re-attribution below exists to
      // prevent. Only the `created` branch runs `openPathAsWorkspace`, so only
      // there is the workspace both new and active. Otherwise we fall through
      // to the managed identity, exactly as before provisioning existed.
      if (ensured?.kind === "created" && primaryRootOf(ensured.project)) {
        project = ensured.project
        root = primaryRootOf(ensured.project)
        // Re-attribute: a conversation names the workspace it runs in
        // (ADR-0144), and `openPathAsWorkspace` has already activated it. Move
        // the reverse link too, or the row's workspace and the workspace's
        // session list disagree from the first turn.
        if (ownerProjectId && ownerProjectId !== ensured.project.id) {
          store.removeSessionFromProject(ownerProjectId, session.id)
        }
        store.addSessionToProject(ensured.project.id, session.id)
        await updateSession(session.id, { projectId: ensured.project.id })
        session = { ...session, projectId: ensured.project.id }
        // Everything downstream that writes a remembered default keys off this,
        // and it belongs to the workspace the conversation runs in.
        ownerProjectId = ensured.project.id
      }
    }
    // What the repository declares, and only once the user has approved it.
    // It sits BELOW the workspace's own remembered default: the file changes on
    // every pull, and a setting that silently reverts is worse than one that
    // was never offered. Above the hardcoded fallback, because "this project
    // runs in its own worktree" is exactly the thing a new contributor should
    // not have to be told out of band.
    const declared =
      project && root
        ? await loadDeclaredWorkspace(project, {
            configRoot: root.path,
            trustEnabled: useSettingsStore.getState().settings?.workspaceTrust?.enabled !== false,
            onWeb: !isTauri(),
          }).catch(() => null)
        : null
    const executionContext =
      project && root
        ? createSessionExecutionContext({
            sessionId: session.id,
            projectId: project.id,
            projectRoot: root.path,
            rootId: root.id,
            environmentId: project.defaultEnvironmentId,
            requestedLocation:
              executionLocation ??
              project.defaultExecutionLocation ??
              declared?.executionLocation ??
              "managedWorktree",
            isGitRepository: false,
            base: executionBase ?? declared?.base,
            now: Date.now(),
          })
        : createManagedWorkspaceContext(
            session.id,
            Date.now(),
            undefined,
            ownerProjectId ?? undefined
          )
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
  } else if (ownerProjectId) {
    // The remembered default belongs to the workspace this conversation runs
    // in, not to whichever one the UI happens to be showing.
    updateProject(ownerProjectId, {
      defaultExecutionLocation: partial.executionContext.location,
    })
  }

  if (ownerProjectId && executionLocation) {
    updateProject(ownerProjectId, { defaultExecutionLocation: executionLocation })
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
