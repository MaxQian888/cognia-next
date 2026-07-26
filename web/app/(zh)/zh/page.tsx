import type { Metadata } from "next"
import { HomePage } from "@web/components/home/home-page"
import { zh } from "@web/content/zh"
import { buildMetadata } from "@web/lib/metadata"

export const metadata: Metadata = buildMetadata("zh", "/", zh.meta.home)

export default function Page() {
  return <HomePage locale="zh" />
}
