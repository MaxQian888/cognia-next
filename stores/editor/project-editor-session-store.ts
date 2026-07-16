import { create } from "zustand"
import { createJSONStorage, persist } from "zustand/middleware"
import type { ProjectEditorSession } from "@/types/editor/project-editor"

const STORAGE_KEY = "cognia-project-editor-sessions"
const LEGACY_AGENT_TEAM_STORAGE_KEY = "cognia-agent-teams"

interface ProjectEditorSessionState {
  sessions: Record<string, ProjectEditorSession>
  setSession: (scopeKey: string, patch: Partial<ProjectEditorSession>) => void
}

interface PersistedEnvelope {
  state?: {
    sessions?: Record<string, ProjectEditorSession>
    editorSession?: Record<string, ProjectEditorSession>
  }
}

const DEFAULTS = {
  sessions: {} as Record<string, ProjectEditorSession>,
}

function accountStorageKey(accountId: string): string {
  return `${STORAGE_KEY}:${accountId}`
}

function readEnvelope(key: string): PersistedEnvelope | null {
  if (typeof window === "undefined") return null
  const raw = window.localStorage.getItem(key)
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === "object" ? (parsed as PersistedEnvelope) : null
  } catch {
    return null
  }
}

function readSessions(key: string): Record<string, ProjectEditorSession> {
  const sessions = readEnvelope(key)?.state?.sessions
  return sessions && typeof sessions === "object" ? sessions : {}
}

function importLegacyTeamSessions(accountId: string): Record<string, ProjectEditorSession> {
  const legacy = readEnvelope(`${LEGACY_AGENT_TEAM_STORAGE_KEY}:${accountId}`)?.state?.editorSession
  if (!legacy || typeof legacy !== "object") return {}
  return Object.fromEntries(
    Object.entries(legacy).map(([teamId, session]) => [`team:${teamId}`, session])
  )
}

export const useProjectEditorSessionStore = create<ProjectEditorSessionState>()(
  persist(
    (set) => ({
      ...DEFAULTS,
      setSession: (scopeKey, patch) =>
        set((state) => {
          const previous = state.sessions[scopeKey] ?? {
            rootKey: "",
            openPaths: [],
            activePath: null,
          }
          return {
            sessions: {
              ...state.sessions,
              [scopeKey]: { ...previous, ...patch },
            },
          }
        }),
    }),
    {
      name: STORAGE_KEY,
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ sessions: state.sessions }),
    }
  )
)

export function activateProjectEditorAccountStorage(accountId: string): void {
  if (typeof window === "undefined") return
  const storageKey = accountStorageKey(accountId)
  const hasCurrentSnapshot = window.localStorage.getItem(storageKey) !== null
  const sessions = hasCurrentSnapshot
    ? readSessions(storageKey)
    : importLegacyTeamSessions(accountId)
  useProjectEditorSessionStore.persist.setOptions({ name: storageKey })
  useProjectEditorSessionStore.setState({ ...DEFAULTS, sessions })
}

export function clearProjectEditorAccountStorage(): void {
  if (typeof window === "undefined") return
  useProjectEditorSessionStore.persist.setOptions({ name: STORAGE_KEY })
  useProjectEditorSessionStore.setState(DEFAULTS)
}

export function purgeProjectEditorAccountStorage(accountId: string): void {
  if (typeof window === "undefined") return
  window.localStorage.removeItem(accountStorageKey(accountId))
}
