/**
 * Agent Teams workspace page (server entry).
 *
 * Next.js `output: "export"` requires every dynamic route segment to declare
 * the params it should pre-render via `generateStaticParams`. teamIds are
 * stored in Dexie and only known at runtime in the Tauri shell, so we ship
 * an empty list — the route is reachable via client-side navigation from
 * `/agent-teams`. Splitting the actual UI into a `"use client"` child
 * (`workspace-client.tsx`) keeps `generateStaticParams` valid (it can only
 * be exported from a Server Component).
 */

import { AgentTeamWorkspaceClient } from "./workspace-client"

interface PageProps {
  params: Promise<{ teamId: string }>
}

// Static export requires `dynamicParams = false`; teamIds aren't known at
// build time so we pre-render a single sentinel and let the client child
// resolve the real id from the URL at runtime via `usePromise(params)`.
export function generateStaticParams(): Array<{ teamId: string }> {
  return [{ teamId: "_" }]
}

export const dynamicParams = false

export default function AgentTeamWorkspacePage({ params }: PageProps) {
  return <AgentTeamWorkspaceClient params={params} />
}
