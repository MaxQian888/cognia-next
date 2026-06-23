"use client"

import { EvalWorkspace } from "@/components/eval/eval-workspace"

/**
 * Dedicated full-page Agent evaluation route. Hosts the eval workspace
 * (datasets/runs dashboard + trace-analysis panel). Data lives in Dexie, so it
 * works in the browser and on desktop; runs need the sidecar to drive tools.
 */
export default function EvalPage() {
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col" data-bg-target="chat">
      <EvalWorkspace />
    </div>
  )
}
