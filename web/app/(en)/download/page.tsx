import type { Metadata } from "next"
import { DownloadPage } from "@web/components/pages/download-page"
import { en } from "@web/content/en"
import { buildMetadata } from "@web/lib/metadata"

export const metadata: Metadata = buildMetadata("en", "/download", en.meta.download)

export default function Page() {
  return <DownloadPage locale="en" />
}
