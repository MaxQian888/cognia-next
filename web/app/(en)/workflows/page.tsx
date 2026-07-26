import type { Metadata } from "next"
import { WorkflowsPage } from "@web/components/pages/workflows-page"
import { en } from "@web/content/en"
import { buildMetadata } from "@web/lib/metadata"

export const metadata: Metadata = buildMetadata("en", "/workflows", en.meta.workflows)

export default function Page() {
  return <WorkflowsPage locale="en" />
}
