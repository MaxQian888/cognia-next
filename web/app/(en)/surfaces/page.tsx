import type { Metadata } from "next"
import { SurfacesPage } from "@web/components/pages/surfaces-page"
import { en } from "@web/content/en"
import { buildMetadata } from "@web/lib/metadata"

export const metadata: Metadata = buildMetadata("en", "/surfaces", en.meta.surfaces)

export default function Page() {
  return <SurfacesPage locale="en" />
}
