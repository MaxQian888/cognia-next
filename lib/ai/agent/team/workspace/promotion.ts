/** Neutral branch-promotion record shared by review and PR delivery. */
export interface PromotionWorkspaceHandle {
  key: string
  logicalRootId: string
  runId: string
  teammateName: string
  taskId: string
  branch: string
  path: string
}

const UNSAFE_SEGMENT = /[^a-zA-Z0-9._-]+/g

/** Reduce arbitrary actor/task text to a git-ref-safe path segment. */
export function sanitizePromotionSegment(raw: string): string {
  const cleaned = raw.replace(UNSAFE_SEGMENT, "-").replace(/^[-.]+|[-.]+$/g, "")
  return cleaned.length > 0 ? cleaned : "x"
}
