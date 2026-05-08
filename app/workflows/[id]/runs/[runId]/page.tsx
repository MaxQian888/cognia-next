/**
 * /workflows/[id]/runs/[runId] — Gantt timeline + step inspector for one run.
 *
 * Server component entry for `output: "export"`. The UI lives in
 * page-client.tsx so this file can export generateStaticParams without
 * being a "use client" module.
 */

import { WorkflowRunDetailPageClient } from "./page-client"

export function generateStaticParams(): Array<{ id: string; runId: string }> {
  return [{ id: "_", runId: "_" }]
}

export const dynamicParams = false

interface PageProps {
  params: Promise<{ id: string; runId: string }>
}

export default function WorkflowRunDetailPage({ params }: PageProps) {
  return <WorkflowRunDetailPageClient params={params} />
}
