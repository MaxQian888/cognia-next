import type { Metadata } from "next"
import { TrustPage } from "@web/components/pages/trust-page"
import { zh } from "@web/content/zh"
import { buildMetadata } from "@web/lib/metadata"

export const metadata: Metadata = buildMetadata("zh", "/trust", zh.meta.trust)

export default function Page() {
  return <TrustPage locale="zh" />
}
