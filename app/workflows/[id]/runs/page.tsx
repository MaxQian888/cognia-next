/**
 * /workflows/[id]/runs — list of past + in-flight runs for a single workflow.
 *
 * Server component entry for `output: "export"`. The UI lives in
 * page-client.tsx so this file can export generateStaticParams without
 * being a "use client" module.
 */

import { WorkflowRunsListPageClient } from "./page-client"

export function generateStaticParams(): Array<{ id: string }> {
  return [{ id: "_" }]
}

export const dynamicParams = false

interface PageProps {
  params: Promise<{ id: string }>
}

export default function WorkflowRunsListPage({ params }: PageProps) {
  return <WorkflowRunsListPageClient params={params} />
}
