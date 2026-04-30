/**
 * Chat hooks barrel.
 *
 * Wires the Claude sidecar (`useClaudeChat`), team orchestration
 * (`useTeamChat`), session-list/CRUD (`useSessions`), system
 * notifications on stream completion (`useSessionNotifications`),
 * and artifact detection helpers used by the message renderer.
 */

export { useClaudeChat } from "./use-claude-chat"
export { useTeamChat } from "./use-team-chat"
export { useSessions } from "./use-sessions"
export { useSessionNotifications } from "./use-session-notifications"
export {
  useArtifactDetection,
  detectArtifactType,
  mapToArtifactLanguage,
  type DetectedArtifact,
} from "./use-artifact-detection"
