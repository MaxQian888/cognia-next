import type { Metadata } from "next"
import { ProductPage } from "@web/components/pages/product-page"
import { en } from "@web/content/en"
import { buildMetadata } from "@web/lib/metadata"

export const metadata: Metadata = buildMetadata("en", "/product", en.meta.product)

export default function Page() {
  return <ProductPage locale="en" />
}
