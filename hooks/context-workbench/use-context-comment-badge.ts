import { useLiveQuery } from "dexie-react-hooks"
import { listUnresolvedContextComments } from "@/lib/db/context-comments"
import type { ContextCommentResourceKind } from "@/types/context-comment"

export function useContextCommentBadge(
  resourceKind: ContextCommentResourceKind,
  resourceId: string | null | undefined
): number {
  const unresolved = useLiveQuery(
    () =>
      resourceId ? listUnresolvedContextComments(resourceKind, resourceId) : Promise.resolve([]),
    [resourceKind, resourceId],
    []
  )
  return unresolved.length
}
