import type { Metadata } from "next"
import { ChangelogPage } from "@web/components/pages/changelog-page"
import { zh } from "@web/content/zh"
import { buildMetadata } from "@web/lib/metadata"

export const metadata: Metadata = buildMetadata("zh", "/changelog", zh.meta.changelog)

export default function Page() {
  return <ChangelogPage locale="zh" />
}
