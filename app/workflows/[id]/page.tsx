/**
 * /workflows/[id] — full-screen visual workflow editor.
 *
 * Server component entry for `output: "export"`. The UI lives in
 * page-client.tsx so this file can export generateStaticParams without
 * being a "use client" module.
 */

import { WorkflowEditorPageClient } from "./page-client"

export function generateStaticParams(): Array<{ id: string }> {
  return [{ id: "_" }]
}

export const dynamicParams = false

interface PageProps {
  params: Promise<{ id: string }>
}

export default function WorkflowEditorPage({ params }: PageProps) {
  return <WorkflowEditorPageClient params={params} />
}
