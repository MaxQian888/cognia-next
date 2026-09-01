"use client"

/**
 * `/me/agent-teams-settings` redirects to `/squads`.
 *
 * This page predates ADR-0140 and rested on a premise that ADR-0140 removed.
 * It was a `<PairedOnly>` READ-ONLY list of Squad templates, on the reasoning
 * (ADR-0056 D6) that "agent teams are a desktop-collaboration runtime" and the
 * standalone in-webview engine "runs no agent loop", so a phone could only look
 * at what a paired desktop would launch.
 *
 * A Squad is host-neutral now. `/squads` declares `standalone: "full"` and
 * `companion: "remote"`, carries no `isTauri` gate anywhere in its component
 * tree, and reads a persisted store rather than a desktop-only one. It also
 * shows strictly more than this page did: the templates panel it duplicated
 * lives in the Squads library, and the fleet answers the question a phone
 * actually opens this for, which is what is running and what needs an answer.
 *
 * A redirect rather than a deletion, because the Me row and any bookmark still
 * name this path. Client-side is the only kind a static export has.
 */

import { useEffect } from "react"
import { useRouter } from "next/navigation"

export default function AgentTeamsSettingsPage() {
  const router = useRouter()
  useEffect(() => {
    router.replace("/squads")
  }, [router])
  return null
}
