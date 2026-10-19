import type { Metadata } from "next"
import { SurfacesPage } from "@web/components/pages/surfaces-page"
import { zh } from "@web/content/zh"
import { buildMetadata } from "@web/lib/metadata"

export const metadata: Metadata = buildMetadata("zh", "/surfaces", zh.meta.surfaces)

export default function Page() {
  return <SurfacesPage locale="zh" />
}
