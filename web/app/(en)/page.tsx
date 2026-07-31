import type { Metadata } from "next"
import { HomePage } from "@web/components/home/home-page"
import { en } from "@web/content/en"
import { buildMetadata } from "@web/lib/metadata"

export const metadata: Metadata = buildMetadata("en", "/", en.meta.home)

export default function Page() {
  return <HomePage locale="en" />
}
