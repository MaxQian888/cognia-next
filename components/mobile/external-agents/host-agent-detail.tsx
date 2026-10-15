"use client"

import { useRouter } from "next/navigation"
import { HostAgentEditor } from "@/components/agent/external-agent/host/host-agent-editor"
import { EXTERNAL_AGENTS_ROUTE, externalAgentDetailHref } from "./routes"

/** The shared editor owns drafts; the phone owns navigation. */
export function HostAgentDetail({ configId }: { configId: string }) {
  const router = useRouter()
  return (
    <HostAgentEditor
      configId={configId}
      onRemoved={() => router.replace(EXTERNAL_AGENTS_ROUTE)}
      onDuplicated={(id) => router.push(externalAgentDetailHref(id))}
      onOpenConfig={(id) => router.push(externalAgentDetailHref(id))}
    />
  )
}
