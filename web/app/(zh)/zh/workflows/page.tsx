import type { Metadata } from "next"
import { WorkflowsPage } from "@web/components/pages/workflows-page"
import { zh } from "@web/content/zh"
import { buildMetadata } from "@web/lib/metadata"

export const metadata: Metadata = buildMetadata("zh", "/workflows", zh.meta.workflows)

export default function Page() {
  return <WorkflowsPage locale="zh" />
}
