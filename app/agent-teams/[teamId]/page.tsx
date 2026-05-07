"use client"

/**
 * Redirects `/agent-teams/[teamId]` to `/agent-teams/workspace?teamId=…`
 * so the canonical workspace route is the search-param form, which is
 * compatible with Next.js `output: "export"`.
 */

import { use, useEffect } from "react"
import { useRouter } from "next/navigation"

interface PageProps {
  params: Promise<{ teamId: string }>
}

export default function AgentTeamRedirectPage({ params }: PageProps) {
  const { teamId } = use(params)
  const router = useRouter()

  useEffect(() => {
    router.replace(`/agent-teams/workspace?teamId=${encodeURIComponent(teamId)}`)
  }, [teamId, router])

  return null
}
