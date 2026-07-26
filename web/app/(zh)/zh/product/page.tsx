import type { Metadata } from "next"
import { ProductPage } from "@web/components/pages/product-page"
import { zh } from "@web/content/zh"
import { buildMetadata } from "@web/lib/metadata"

export const metadata: Metadata = buildMetadata("zh", "/product", zh.meta.product)

export default function Page() {
  return <ProductPage locale="zh" />
}
