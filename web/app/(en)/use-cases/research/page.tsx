import type { Metadata } from "next"
import { UseCasePage } from "@web/components/pages/use-case-page"
import { en } from "@web/content/en"
import { buildMetadata } from "@web/lib/metadata"

export const metadata: Metadata = buildMetadata(
  "en",
  "/use-cases/research",
  en.meta.useCasesResearch
)

export default function Page() {
  return <UseCasePage locale="en" variant="research" />
}
