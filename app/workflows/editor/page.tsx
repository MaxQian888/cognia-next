"use client"

import RouteBody from "./route-body"

/**
 * /workflows/editor?id=… — full-screen visual workflow editor.
 *
 * Static route (no dynamic segment) so Next's `output: "export"` always emits
 * a physical HTML file; the runtime workflow id arrives via the query string.
 * Replaces the old `/workflows/[id]` dynamic route, which could not be served
 * for runtime-created ids in the Tauri static export (the asset fallback chain
 * served the root index.html and rendered the home page instead).
 */

import { Suspense, useEffect, useState } from "react"
import { notFound, useRouter, useSearchParams } from "next/navigation"
import { toast } from "sonner"
import { Skeleton } from "@/components/ui/skeleton"
import { getWorkflow } from "@/lib/db/workflows"
import type { WorkflowRow } from "@/types/workflow/visual"

function WorkflowEditorInner() {
  const router = useRouter()
  const searchParams = useSearchParams()
  const id = searchParams.get("id")
  const [workflow, setWorkflow] = useState<WorkflowRow | null | undefined>(undefined)

  // `?template=<id>` (Discover's "Open" on a workflow template): captured once
  // for the editor to open that template's slot form, then dropped from the
  // URL so a reload returns to the plain workflow.
  const templateParam = searchParams.get("template")
  const [initialTemplateId] = useState(templateParam ?? undefined)
  useEffect(() => {
    if (!templateParam || !id) return
    router.replace(`/workflows/editor?id=${encodeURIComponent(id)}`, { scroll: false })
  }, [templateParam, id, router])

  useEffect(() => {
    if (!id) return
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

  // No `?id=` → treat as not-found synchronously (no Dexie round-trip). Kept in
  // the render path rather than the effect to avoid a setState-in-effect.
  if (!id) {
    notFound()
  }

  if (workflow === undefined) {
    return <EditorLoadingSkeleton />
  }

  if (workflow === null) {
    notFound()
  }

  return <RouteBody workflow={workflow} initialTemplateId={initialTemplateId} />
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

export default function WorkflowEditorPage() {
  return (
    <Suspense fallback={<EditorLoadingSkeleton />}>
      <WorkflowEditorInner />
    </Suspense>
  )
}
