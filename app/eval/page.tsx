"use client"

import { Suspense } from "react"
import { useSearchParams } from "next/navigation"

import { EvalWorkspace } from "@/components/eval/eval-workspace"
import { EvalLabWorkspace } from "@/components/eval/eval-lab-workspace"
import { isEvalLabEnabled } from "@/lib/ai/eval/feature-flags"

/**
 * Dedicated full-page Agent evaluation route. Hosts the eval workspace
 * (datasets/runs dashboard + trace-analysis panel). Data lives in Dexie, so it
 * works in the browser and on desktop; runs need the sidecar to drive tools.
 *
 * `?dataset=<id>` opens that dataset (the twin persona tab links here after
 * generating a benchmark). `useSearchParams` needs the Suspense boundary.
 */
export default function EvalPage() {
  return (
    <div className="flex h-full min-h-0 flex-1 flex-col" data-bg-target="chat">
      <Suspense fallback={null}>
        <EvalPageBody />
      </Suspense>
    </div>
  )
}

function EvalPageBody() {
  const datasetId = useSearchParams().get("dataset") ?? undefined
  // Keyed so a second `?dataset=` link while the page is open still selects.
  return isEvalLabEnabled() ? (
    <EvalLabWorkspace key={datasetId} initialDatasetId={datasetId} />
  ) : (
    <EvalWorkspace key={datasetId} initialDatasetId={datasetId} />
  )
}
