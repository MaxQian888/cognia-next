import type { Metadata } from "next"
import { ChangelogPage } from "@web/components/pages/changelog-page"
import { en } from "@web/content/en"
import { buildMetadata } from "@web/lib/metadata"

export const metadata: Metadata = buildMetadata("en", "/changelog", en.meta.changelog)

export default function Page() {
  return <ChangelogPage locale="en" />
}
