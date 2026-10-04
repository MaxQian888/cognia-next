"use client"

import { WorkflowEditorCanvas } from "@/components/workflow/editor/canvas"
import { MobileWorkflowEditor } from "@/components/mobile/workflow/editor/mobile-workflow-editor"
import type { WorkflowRow } from "@/types/workflow/visual"
import { useIsMobile } from "@/hooks/ui/use-mobile"

export interface RouteBodyProps {
  workflow: WorkflowRow
  initialTemplateId?: string
}
export default function RouteBody(props: RouteBodyProps) {
  const compact = useIsMobile()
  return compact ? (
    <div className="min-h-0 w-full flex-1 overflow-hidden">
      <MobileWorkflowEditor workflow={props.workflow} />
    </div>
  ) : (
    <div className="h-full w-full overflow-hidden" data-bg-target="canvas">
      <WorkflowEditorCanvas {...props} />
    </div>
  )
}
