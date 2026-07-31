import type { Metadata } from "next"
import { TrustPage } from "@web/components/pages/trust-page"
import { en } from "@web/content/en"
import { buildMetadata } from "@web/lib/metadata"

export const metadata: Metadata = buildMetadata("en", "/trust", en.meta.trust)

export default function Page() {
  return <TrustPage locale="en" />
}
