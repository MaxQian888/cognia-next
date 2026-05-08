/**
 * Redirects `/agent-teams/[teamId]` to `/agent-teams/workspace?teamId=…`
 * so the canonical workspace route is the search-param form, which is
 * compatible with Next.js `output: "export"`.
 *
 * Server component entry — the redirect logic lives in page-client.tsx so
 * this file can export generateStaticParams.
 */

import { AgentTeamRedirectPageClient } from "./page-client"

export function generateStaticParams(): Array<{ teamId: string }> {
  return [{ teamId: "_" }]
}

export const dynamicParams = false

interface PageProps {
  params: Promise<{ teamId: string }>
}

export default function AgentTeamRedirectPage({ params }: PageProps) {
  return <AgentTeamRedirectPageClient params={params} />
}
