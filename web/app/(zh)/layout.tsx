import "../globals.css"
import type { Metadata } from "next"
import type { ReactNode } from "react"
import { RootDocument } from "@web/components/root-document"
import { zh } from "@web/content/zh"
import { siteUrl } from "@web/lib/site"

// The Chinese root layout. Its pages live under `zh/`, so every path in this
// group carries the `/zh` prefix.
export const metadata: Metadata = {
  metadataBase: new URL(siteUrl()),
  title: { template: zh.meta.titleTemplate, default: zh.meta.home.title },
}

export default function ChineseRootLayout({ children }: { children: ReactNode }) {
  return <RootDocument locale="zh">{children}</RootDocument>
}
