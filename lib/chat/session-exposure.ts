interface ExposableSession {
  kind?: string
  visibility?: string
}

export type SessionExposureChannel =
  | "main-list"
  | "global-search"
  | "plugin-enumeration"
  | "external-connector"
  | "authenticated-project-sync"
  | "standard-export"
  | "resource-export"

const EMBEDDED_ALLOWED_CHANNELS = new Set<SessionExposureChannel>([
  "authenticated-project-sync",
  "resource-export",
])

export function isEmbeddedSession(session: ExposableSession): boolean {
  return (
    session.visibility === "embedded" ||
    session.kind === "resource-workbench" ||
    session.kind === "workflow-editor" ||
    session.kind === "subagent"
  )
}

export function isSessionExposed(
  session: ExposableSession,
  channel: SessionExposureChannel
): boolean {
  if (!isEmbeddedSession(session)) return true
  if (session.kind === "subagent") return false
  return EMBEDDED_ALLOWED_CHANNELS.has(channel)
}

export function filterExposedSessions<T extends ExposableSession>(
  sessions: readonly T[],
  channel: SessionExposureChannel
): T[] {
  return sessions.filter((session) => isSessionExposed(session, channel))
}
