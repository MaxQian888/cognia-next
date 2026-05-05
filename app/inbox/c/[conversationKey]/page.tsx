/**
 * /inbox/c/[conversationKey] — conversation detail route.
 *
 * Server component entry for `output: "export"`. The UI lives in
 * page-client.tsx so this file can export generateStaticParams without
 * being a "use client" module.
 */

import { ConversationPageClient } from "./page-client"

// Required for `output: "export"` static generation; actual data is loaded
// client-side from Dexie so the static shell is always an empty array.
export function generateStaticParams(): Array<{ conversationKey: string }> {
  return [{ conversationKey: "_" }]
}

export const dynamicParams = false

interface PageProps {
  params: Promise<{ conversationKey: string }>
}

export default function ConversationPage({ params }: PageProps) {
  return <ConversationPageClient params={params} />
}
