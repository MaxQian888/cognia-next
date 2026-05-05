/**
 * /inbox/adapter/[adapterId] — per-adapter conversation list.
 *
 * Server component entry for `output: "export"`. The UI lives in
 * page-client.tsx so this file can export generateStaticParams without
 * being a "use client" module.
 */

import { AdapterInboxPageClient } from "./page-client"

// Required for `output: "export"` static generation; actual data is loaded
// client-side from Dexie so the static shell is always an empty array.
export function generateStaticParams(): Array<{ adapterId: string }> {
  return [{ adapterId: "_" }]
}

export const dynamicParams = false

interface PageProps {
  params: Promise<{ adapterId: string }>
}

export default function AdapterInboxPage({ params }: PageProps) {
  return <AdapterInboxPageClient params={params} />
}
