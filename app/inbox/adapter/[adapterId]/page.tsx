/**
 * /inbox/adapter/[adapterId] — per-adapter conversation list.
 *
 * Server component entry for `output: "export"`. The UI lives in
 * page-client.tsx so this file can export generateStaticParams without
 * being a "use client" module.
 */

import { AdapterInboxPageClient } from "./page-client"

// Production `output: "export"` emits only this stub HTML; Tauri's webview
// handles real ids via SPA client routing. Dev runs without `output: export`
// (see next.config.ts), so it can render any id dynamically — we intentionally
// don't export `dynamicParams = false`, which would break dev navigation under
// Next 16's strict static-export checks (vercel/next.js#56477).
export function generateStaticParams(): Array<{ adapterId: string }> {
  return [{ adapterId: "_" }]
}

interface PageProps {
  params: Promise<{ adapterId: string }>
}

export default function AdapterInboxPage({ params }: PageProps) {
  return <AdapterInboxPageClient params={params} />
}
