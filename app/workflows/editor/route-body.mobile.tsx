"use client"

import { MobileWorkflowEditor } from "@/components/mobile/workflow/editor/mobile-workflow-editor"
import type { RouteBodyProps } from "./route-body"

export default function RouteBody(props: RouteBodyProps) {
  return (
    <div className="min-h-0 w-full flex-1 overflow-hidden">
      <MobileWorkflowEditor workflow={props.workflow} />
    </div>
  )
}
