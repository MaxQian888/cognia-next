import type { ReactNode } from "react"
import { DocsLayout } from "fumadocs-ui/layouts/docs"
import { source } from "@/lib/source"
import { baseOptions } from "@/lib/layout.shared"
import { ReadingProgress } from "@/components/reading-progress"
import { BackToTop } from "@/components/back-to-top"

export default async function Layout({
  params,
  children,
}: {
  params: Promise<{ lang: string }>
  children: ReactNode
}) {
  const { lang } = await params

  return (
    <>
      <ReadingProgress />
      <DocsLayout {...baseOptions(lang)} tree={source.getPageTree(lang)}>
        {children}
      </DocsLayout>
      <BackToTop />
    </>
  )
}
