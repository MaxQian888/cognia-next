import type { Metadata } from "next"
import { PluginsPage } from "@web/components/pages/plugins-page"
import { zh } from "@web/content/zh"
import { buildMetadata } from "@web/lib/metadata"

export const metadata: Metadata = buildMetadata("zh", "/plugins", zh.meta.plugins)

export default function Page() {
  return <PluginsPage locale="zh" />
}
