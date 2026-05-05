/**
 * /inbox/platform/[kind] — per-platform conversation list.
 *
 * Server component entry for `output: "export"`. The UI lives in
 * page-client.tsx so this file can export generateStaticParams without
 * being a "use client" module.
 */

import { PlatformInboxPageClient } from "./page-client"

// Required for `output: "export"` static generation; actual data is loaded
// client-side from Dexie so the static shell is always an empty array.
export function generateStaticParams(): Array<{ kind: string }> {
  return [{ kind: "_" }]
}

export const dynamicParams = false

interface PageProps {
  params: Promise<{ kind: string }>
}

export default function PlatformInboxPage({ params }: PageProps) {
  return <PlatformInboxPageClient params={params} />
}
