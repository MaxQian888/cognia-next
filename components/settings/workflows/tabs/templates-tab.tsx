"use client"

import { useLiveQuery } from "dexie-react-hooks"
import { SparklesIcon } from "lucide-react"
import { listTemplateWorkflows } from "@/lib/db/workflows"
import { WorkflowCard } from "@/components/workflow/library/workflow-card"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { Skeleton } from "@/components/ui/skeleton"

export function TemplatesTab() {
  const templates = useLiveQuery(() => listTemplateWorkflows(), [])

  if (templates === undefined) {
    return (
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-32 rounded-lg" />
        ))}
      </div>
    )
  }

  if (templates.length === 0) {
    return (
      <Empty className="mx-auto max-w-md py-12">
        <EmptyHeader>
          <EmptyMedia>
            <SparklesIcon className="size-8" aria-hidden="true" />
          </EmptyMedia>
        </EmptyHeader>
        <EmptyTitle>Templates gallery</EmptyTitle>
        <EmptyDescription>
          Built-in templates will land here — daily standup digest, inbound message → twin RAG →
          reply, cron-triggered team review, onboarding character generator. Duplicate any of them
          to start from a working pipeline.
        </EmptyDescription>
      </Empty>
    )
  }

  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {templates.map((wf) => (
        <WorkflowCard key={wf.id} workflow={wf} />
      ))}
    </div>
  )
}
