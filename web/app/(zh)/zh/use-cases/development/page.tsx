import type { Metadata } from "next"
import { UseCasePage } from "@web/components/pages/use-case-page"
import { zh } from "@web/content/zh"
import { buildMetadata } from "@web/lib/metadata"

export const metadata: Metadata = buildMetadata(
  "zh",
  "/use-cases/development",
  zh.meta.useCasesDevelopment
)

export default function Page() {
  return <UseCasePage locale="zh" variant="development" />
}
