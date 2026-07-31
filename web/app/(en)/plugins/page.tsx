import type { Metadata } from "next"
import { PluginsPage } from "@web/components/pages/plugins-page"
import { en } from "@web/content/en"
import { buildMetadata } from "@web/lib/metadata"

export const metadata: Metadata = buildMetadata("en", "/plugins", en.meta.plugins)

export default function Page() {
  return <PluginsPage locale="en" />
}
