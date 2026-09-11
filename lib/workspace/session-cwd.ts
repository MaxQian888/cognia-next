/**
 * Which directory a chat session runs in, answered from Dexie alone.
 *
 * `resolveSendOptions` resolves a turn's working directory from the session
 * row, its execution binding, the workspace it belongs to, the character and
 * the app default (`lib/workspace/effective-cwd.ts`). A `dispatch_agent` call
 * has none of those objects in hand, only the parent session's id, so a child
 * used to start with NO cwd: the sidecar fell back to the process directory,
 * project instruction files (CLAUDE.md) were never discovered for it, and
 * relative paths in the dispatcher's prompt pointed somewhere else.
 *
 * This reads the same chain from the database so a dispatched child inherits
 * exactly the directory its parent turn ran in. Every read is best-effort: a
 * deleted workspace or character resolves further down the chain rather than
 * failing the dispatch. A session with no workspace does not borrow the
 * on-screen one (see `resolveSessionExecutionRoot`), which keeps the child on
 * the parent's directory instead of whatever the user is looking at.
 */
import type { AppSettings, ChatSession } from "@cognia/agent-config-types"
import type { Project } from "@/types"
import { resolveCharacterById } from "@/lib/db/characters"
import { getDb } from "@/lib/db/schema"
import { getSession } from "@/lib/db/sessions"
import { getSettings } from "@/lib/db/settings"
import { resolveSessionWorkspaceRoot } from "@/lib/task-workspace/session-execution-context"
import { resolveEffectiveCwd } from "@/lib/workspace/effective-cwd"

/** Reads, injectable so the resolver tests without a database. */
export interface SessionCwdDeps {
  getSession: (id: string) => Promise<ChatSession | undefined>
  getProject: (id: string) => Promise<Pick<Project, "roots"> | undefined>
  getCharacterWorkingDir: (characterId: string) => Promise<string | undefined>
  getDefaultWorkingDir: () => Promise<string | undefined>
}

const defaultDeps: SessionCwdDeps = {
  getSession,
  getProject: async (id) => (await getDb().projects.get(id)) ?? undefined,
  getCharacterWorkingDir: async (characterId) =>
    (await resolveCharacterById(characterId))?.workingDir ?? undefined,
  getDefaultWorkingDir: async () =>
    (await getSettings().then((settings: AppSettings) => settings.defaultWorkingDir)) ?? undefined,
}

async function quiet<T>(read: () => Promise<T>): Promise<T | undefined> {
  try {
    return await read()
  } catch {
    return undefined
  }
}

/**
 * The working directory the session's next turn would run in, or `undefined`
 * when nothing in the chain names one. Unknown session ids resolve to
 * `undefined` too, never to the app default: a child of a session that does
 * not exist has no directory to inherit.
 */
export async function resolveSessionCwd(
  sessionId: string,
  deps: SessionCwdDeps = defaultDeps
): Promise<string | undefined> {
  const session = await quiet(() => deps.getSession(sessionId))
  if (!session) return undefined
  const [project, characterWorkingDir, defaultWorkingDir] = await Promise.all([
    session.projectId ? quiet(() => deps.getProject(session.projectId as string)) : undefined,
    session.characterId
      ? quiet(() => deps.getCharacterWorkingDir(session.characterId as string))
      : undefined,
    quiet(() => deps.getDefaultWorkingDir()),
  ])
  return resolveEffectiveCwd({
    sessionWorkingDir: session.workingDir,
    executionWorkspaceRoot: session.executionContext
      ? resolveSessionWorkspaceRoot(session.executionContext)
      : undefined,
    activeProject: project ?? null,
    characterWorkingDir,
    defaultWorkingDir,
  })
}
