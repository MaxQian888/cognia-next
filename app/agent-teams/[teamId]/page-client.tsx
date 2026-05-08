"use client"

import { use, useEffect } from "react"
import { useRouter } from "next/navigation"

interface PageProps {
  params: Promise<{ teamId: string }>
}

export function AgentTeamRedirectPageClient({ params }: PageProps) {
  const { teamId } = use(params)
  const router = useRouter()

  useEffect(() => {
    router.replace(`/agent-teams/workspace?teamId=${encodeURIComponent(teamId)}`)
  }, [teamId, router])

  return null
}
