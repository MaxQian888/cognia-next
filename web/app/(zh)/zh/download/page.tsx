import type { Metadata } from "next"
import { DownloadPage } from "@web/components/pages/download-page"
import { zh } from "@web/content/zh"
import { buildMetadata } from "@web/lib/metadata"

export const metadata: Metadata = buildMetadata("zh", "/download", zh.meta.download)

export default function Page() {
  return <DownloadPage locale="zh" />
}
