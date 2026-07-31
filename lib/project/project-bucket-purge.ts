type ProjectBucketPurger = (projectId: string) => void

const ARTIFACT_STORAGE_PREFIX = "cognia-artifacts"
const AGENT_TEAM_STORAGE_PREFIX = "cognia-agent-teams"
const registeredPurgers = new Map<string, ProjectBucketPurger>()

type JsonRecord = Record<string, unknown>

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function filterRecord(value: unknown, keep: (row: JsonRecord, id: string) => boolean): JsonRecord {
  if (!isRecord(value)) return {}
  return Object.fromEntries(
    Object.entries(value).filter(([id, row]) => isRecord(row) && keep(row, id))
  )
}

function purgeArtifactState(state: JsonRecord, projectId: string): void {
  const artifacts = filterRecord(state.artifacts, (row) => row.projectId !== projectId)
  const canvasDocuments = filterRecord(state.canvasDocuments, (row) => row.projectId !== projectId)
  state.artifacts = artifacts
  state.canvasDocuments = canvasDocuments
  state.pendingReviews = filterRecord(
    state.pendingReviews,
    (_row, id) => id in artifacts || id in canvasDocuments
  )

  const openBySession: Record<string, string[]> = {}
  if (isRecord(state.openArtifactIdsBySession)) {
    for (const [sessionId, ids] of Object.entries(state.openArtifactIdsBySession)) {
      if (!Array.isArray(ids)) continue
      const kept = ids.filter((id): id is string => typeof id === "string" && id in artifacts)
      if (kept.length > 0) openBySession[sessionId] = kept
    }
  }
  state.openArtifactIdsBySession = openBySession

  const activeBySession: Record<string, string> = {}
  if (isRecord(state.activeArtifactIdBySession)) {
    for (const [sessionId, id] of Object.entries(state.activeArtifactIdBySession)) {
      if (typeof id === "string" && id in artifacts) activeBySession[sessionId] = id
    }
  }
  state.activeArtifactIdBySession = activeBySession

  if (typeof state.activeCanvasId === "string" && !(state.activeCanvasId in canvasDocuments)) {
    state.activeCanvasId = null
  }
}

function purgeAgentTeamState(state: JsonRecord, projectId: string): void {
  const removedTeamIds = new Set<string>()
  const teams = filterRecord(state.teams, (row, id) => {
    if (row.projectId !== projectId) return true
    removedTeamIds.add(id)
    return false
  })
  state.teams = teams
  state.teammates = filterRecord(
    state.teammates,
    (row) => typeof row.teamId !== "string" || !removedTeamIds.has(row.teamId)
  )
  state.tasks = filterRecord(
    state.tasks,
    (row) => typeof row.teamId !== "string" || !removedTeamIds.has(row.teamId)
  )
  state.editorSession = isRecord(state.editorSession)
    ? Object.fromEntries(
        Object.entries(state.editorSession).filter(([teamId]) => !removedTeamIds.has(teamId))
      )
    : {}
  if (typeof state.activeTeamId === "string" && removedTeamIds.has(state.activeTeamId)) {
    state.activeTeamId = null
  }
}

function purgePersistedSnapshot(
  storage: Storage,
  key: string,
  projectId: string,
  purge: (state: JsonRecord, projectId: string) => void
): void {
  const snapshot = storage.getItem(key)
  if (!snapshot) return
  try {
    const parsed: unknown = JSON.parse(snapshot)
    if (!isRecord(parsed) || !isRecord(parsed.state)) return
    purge(parsed.state, projectId)
    storage.setItem(key, JSON.stringify(parsed))
  } catch {
    // A malformed persisted snapshot is left untouched for the owning store's
    // migration/recovery path; project deletion must remain best-effort.
  }
}

function persistedKeys(storage: Storage): string[] {
  const keys: string[] = []
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index)
    if (key) keys.push(key)
  }
  return keys
}

export function registerProjectBucketPurger(id: string, purge: ProjectBucketPurger): void {
  registeredPurgers.set(id, purge)
}

export function purgeProjectBuckets(
  projectId: string,
  storage: Storage | undefined = typeof window === "undefined" ? undefined : window.localStorage
): void {
  for (const purge of registeredPurgers.values()) {
    try {
      purge(projectId)
    } catch {
      // One optional store must not prevent the remaining buckets from purging.
    }
  }
  if (!storage) return

  for (const key of persistedKeys(storage)) {
    if (key === ARTIFACT_STORAGE_PREFIX || key.startsWith(`${ARTIFACT_STORAGE_PREFIX}:`)) {
      purgePersistedSnapshot(storage, key, projectId, purgeArtifactState)
    } else if (
      key === AGENT_TEAM_STORAGE_PREFIX ||
      key.startsWith(`${AGENT_TEAM_STORAGE_PREFIX}:`)
    ) {
      purgePersistedSnapshot(storage, key, projectId, purgeAgentTeamState)
    }
  }
}
