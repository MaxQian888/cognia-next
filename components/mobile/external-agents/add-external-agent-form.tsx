"use client"

/** Phone navigation for the shared Host configuration form. */

import { useRouter } from "next/navigation"

import { HostAgentCreateForm } from "@/components/agent/external-agent/host/host-agent-create-form"

import { ADD_EXTERNAL_AGENT_ROUTE, EXTERNAL_AGENTS_ROUTE } from "./routes"

export { HOST_UNAVAILABLE_KEY } from "@/components/agent/external-agent/host/host-agent-create-form"

export interface AddExternalAgentFormProps {
  /** A runnable preset id, or `"custom"` for a blank configuration. */
  presetId: string
}

export function AddExternalAgentForm({ presetId }: AddExternalAgentFormProps) {
  const router = useRouter()
  return (
    <HostAgentCreateForm
      presetId={presetId}
      onCreated={() => router.replace(EXTERNAL_AGENTS_ROUTE)}
      onCancel={() => router.push(ADD_EXTERNAL_AGENT_ROUTE)}
    />
  )
}
