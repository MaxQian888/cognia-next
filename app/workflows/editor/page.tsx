"use client"

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
import { notFound, useSearchParams } from "next/navigation"
import { toast } from "sonner"
import { Skeleton } from "@/components/ui/skeleton"
import { WorkflowEditorCanvas } from "@/components/workflow/editor/canvas"
import { MobileWorkflowEditor } from "@/components/mobile/workflow/editor/mobile-workflow-editor"
import { useIsMobile } from "@/hooks/ui/use-mobile"
import { getWorkflow } from "@/lib/db/workflows"
import type { WorkflowRow } from "@/types/workflow/visual"

function WorkflowEditorInner() {
  // Branch on `useIsMobile()` (native Capacitor OR viewport < 768px), not the
  // static `usePlatform() === "mobile"` pin: a phone-width browser / narrow
  // desktop window otherwise fell through to the desktop 3-pane resizable
  // canvas, which is unusable below ~700px.
  const isMobile = useIsMobile()
  const id = useSearchParams().get("id")
  const [workflow, setWorkflow] = useState<WorkflowRow | null | undefined>(undefined)

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

  if (isMobile) {
    // `flex-1 min-h-0` (not `h-full`) so the editor fills the height the
    // mobile shell hands it — on the Capacitor shell that's the flex-column
    // `MobileShellWrapper` (below the offline banner); on a narrow desktop
    // browser it's the desktop shell's flex content area. Both give a definite
    // height the ReactFlow canvas needs; `h-full` collapsed to 0 on mobile.
    return (
      <div className="min-h-0 w-full flex-1 overflow-hidden">
        <MobileWorkflowEditor workflow={workflow} />
      </div>
    )
  }

  return (
    <div className="h-full w-full overflow-hidden" data-bg-target="canvas">
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

export default function WorkflowEditorPage() {
  return (
    <Suspense fallback={<EditorLoadingSkeleton />}>
      <WorkflowEditorInner />
    </Suspense>
  )
}
