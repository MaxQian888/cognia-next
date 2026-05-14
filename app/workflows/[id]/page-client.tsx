"use client"

/**
 * Client component for /workflows/[id]. Loads the workflow by id from Dexie,
 * hands it to the WorkflowEditorCanvas, and falls back to a not-found state
 * if the id is missing. The editor canvas owns its own Zustand+zundo store,
 * so the page just provides the initial workflow.
 *
 * Separated from page.tsx so the parent can export generateStaticParams
 * without becoming a "use client" module.
 */

import { use, useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { toast } from "sonner"
import { WorkflowIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { Empty, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty"
import { WorkflowEditorCanvas } from "@/components/workflow/editor/canvas"
import { WorkflowGraphViewer } from "@/components/mobile/workflow/workflow-graph-viewer"
import { usePlatform } from "@/hooks/use-platform"
import { getWorkflow } from "@/lib/db/workflows"
import type { WorkflowRow } from "@/types/workflow/visual"

interface PageProps {
  params: Promise<{ id: string }>
}

export function WorkflowEditorPageClient({ params }: PageProps) {
  const router = useRouter()
  const platform = usePlatform()
  const { id } = use(params)
  const [workflow, setWorkflow] = useState<WorkflowRow | null | undefined>(undefined)

  useEffect(() => {
    let cancelled = false
    getWorkflow(id)
      .then((wf) => {
        if (cancelled) return
        setWorkflow(wf ?? null)
      })
      .catch((err) => {
        if (cancelled) return
        toast.error(err instanceof Error ? err.message : "Failed to load workflow")
        setWorkflow(null)
      })
    return () => {
      cancelled = true
    }
  }, [id])

  if (workflow === undefined) {
    return <EditorLoadingSkeleton />
  }

  if (workflow === null) {
    return (
      <Empty className="mx-auto max-w-md py-20">
        <EmptyHeader>
          <EmptyMedia>
            <WorkflowIcon className="size-8" aria-hidden="true" />
          </EmptyMedia>
        </EmptyHeader>
        <EmptyTitle>Workflow not found</EmptyTitle>
        <EmptyDescription>
          The workflow you tried to open doesn’t exist or has been deleted.
        </EmptyDescription>
        <Button onClick={() => router.push("/workflows")} className="mt-2">
          Back to library
        </Button>
      </Empty>
    )
  }

  if (platform === "mobile") {
    const graph = {
      nodes: workflow.nodes.map((n) => ({
        id: n.id,
        kind: n.type,
        label: n.data?.label,
        description: n.data?.notes,
      })),
      edges: workflow.edges.map((e) => ({ from: e.source, to: e.target })),
    }
    return (
      <div className="h-full w-full overflow-y-auto p-3">
        <WorkflowGraphViewer graph={graph} />
      </div>
    )
  }

  return (
    <div className="h-full w-full overflow-hidden">
      <WorkflowEditorCanvas workflow={workflow} />
    </div>
  )
}

function EditorLoadingSkeleton() {
  return (
    <div className="flex h-full w-full flex-col">
      <div className="flex items-center gap-2 border-b px-3 py-2">
        <Skeleton className="size-8" />
        <Skeleton className="h-8 w-48" />
        <div className="ml-auto flex gap-2">
          <Skeleton className="h-8 w-8" />
          <Skeleton className="h-8 w-16" />
          <Skeleton className="h-8 w-16" />
        </div>
      </div>
      <div className="flex-1 bg-muted/20" />
    </div>
  )
}
