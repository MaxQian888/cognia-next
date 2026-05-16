/**
 * /workflows/[id] — full-screen visual workflow editor.
 *
 * Server component entry for `output: "export"`. The UI lives in
 * page-client.tsx so this file can export generateStaticParams without
 * being a "use client" module.
 */

import { WorkflowEditorPageClient } from "./page-client"

// Production `output: "export"` emits only this stub HTML; Tauri's webview
// handles real ids via SPA client routing. Dev runs without `output: export`
// (see next.config.ts), so it can render any id dynamically — we intentionally
// don't export `dynamicParams = false`, which would break dev navigation under
// Next 16's strict static-export checks (vercel/next.js#56477).
export function generateStaticParams(): Array<{ id: string }> {
  return [{ id: "_" }]
}

interface PageProps {
  params: Promise<{ id: string }>
}

export default function WorkflowEditorPage({ params }: PageProps) {
  return <WorkflowEditorPageClient params={params} />
}
