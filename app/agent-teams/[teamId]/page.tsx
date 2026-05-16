/**
 * Redirects `/agent-teams/[teamId]` to `/agent-teams/workspace?teamId=…`
 * so the canonical workspace route is the search-param form, which is
 * compatible with Next.js `output: "export"`.
 *
 * Server component entry — the redirect logic lives in page-client.tsx so
 * this file can export generateStaticParams.
 */

import { AgentTeamRedirectPageClient } from "./page-client"

// Production `output: "export"` emits only this stub HTML; Tauri's webview
// handles real ids via SPA client routing. Dev runs without `output: export`
// (see next.config.ts), so it can render any id dynamically — we intentionally
// don't export `dynamicParams = false`, which would break dev navigation under
// Next 16's strict static-export checks (vercel/next.js#56477).
export function generateStaticParams(): Array<{ teamId: string }> {
  return [{ teamId: "_" }]
}

interface PageProps {
  params: Promise<{ teamId: string }>
}

export default function AgentTeamRedirectPage({ params }: PageProps) {
  return <AgentTeamRedirectPageClient params={params} />
}
