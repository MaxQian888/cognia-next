"use client"

/**
 * `/agent-teams` redirects to `/squads`.
 *
 * ADR-0140 retired this route: a Squad is an executor a conversation is handed
 * to, not a place you navigate to. Its six surfaces went to the places that
 * already own each part:
 *
 *  - library, roster and the nine governance sections to Settings, under Squads
 *  - runtime to `/squads`
 *  - activity, operations and consensus to the `/agent-runs` run detail
 *  - live worktrees and reclaimed agent branches to `/workspace`
 *  - chat to the conversation
 *
 * A redirect rather than a 404, because the id survives. A bookmark, or a link
 * inside an old message, names a team, and `/squads?id=` still answers it.
 * Client-side is the only kind available in a static export.
 */

import { Suspense, useEffect } from "react"
import { useRouter, useSearchParams } from "next/navigation"

function AgentTeamsRedirect() {
  const router = useRouter()
  const params = useSearchParams()
  // `teamId` is what the workspace route used. `id` is the spelling `/squads`
  // uses, and older links arrived with either.
  const teamId = params?.get("teamId") ?? params?.get("id") ?? null

  useEffect(() => {
    router.replace(teamId ? `/squads?id=${encodeURIComponent(teamId)}` : "/squads")
  }, [router, teamId])

  return null
}

export default function AgentTeamsPage() {
  return (
    <Suspense fallback={null}>
      <AgentTeamsRedirect />
    </Suspense>
  )
}
