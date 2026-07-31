import "../globals.css"
import type { Metadata } from "next"
import type { ReactNode } from "react"
import { RootDocument } from "@web/components/root-document"
import { en } from "@web/content/en"
import { siteUrl } from "@web/lib/site"

// One root layout per locale (ADR-0092 §4) so `<html lang>` is static rather
// than patched in after hydration. Route groups do not appear in the URL, so
// this group serves the unprefixed English paths.
export const metadata: Metadata = {
  metadataBase: new URL(siteUrl()),
  title: { template: en.meta.titleTemplate, default: en.meta.home.title },
}

export default function EnglishRootLayout({ children }: { children: ReactNode }) {
  return <RootDocument locale="en">{children}</RootDocument>
}
