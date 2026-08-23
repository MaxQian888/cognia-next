import { Suspense } from "react"
import type { Metadata } from "next"
import { WorkflowPortal } from "@/components/workflow/portal/workflow-portal"

export const metadata: Metadata = {
  title: "Cognia Portal",
  robots: { index: false, follow: false },
}

export default function PortalPage() {
  return (
    <Suspense fallback={<main className="min-h-dvh bg-muted/30" />}>
      <WorkflowPortal />
    </Suspense>
  )
}
