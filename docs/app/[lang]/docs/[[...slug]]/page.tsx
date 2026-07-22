import { notFound } from "next/navigation"
import type { Metadata } from "next"
import { DocsPage, DocsBody, DocsTitle, DocsDescription } from "fumadocs-ui/page"
import { source } from "@/lib/source"
import { getMDXComponents } from "@/components/mdx-components"
import { PageFooter } from "@/components/page-footer"
import { getDocsLastModified } from "@/lib/last-modified"

type Props = {
  params: Promise<{ lang: string; slug?: string[] }>
}

export default async function Page({ params }: Props) {
  const { lang, slug } = await params
  const page = source.getPage(slug, lang)
  if (!page) notFound()

  const MDX = page.data.body
  const footerSlug = [lang, ...(slug ?? [])]
  const lastModified = getDocsLastModified(lang, slug)

  return (
    <DocsPage toc={page.data.toc} full={page.data.full}>
      <DocsTitle>{page.data.title}</DocsTitle>
      <DocsDescription>{page.data.description}</DocsDescription>
      <DocsBody>
        <MDX components={getMDXComponents()} />
        <PageFooter slug={footerSlug} lastModified={lastModified} />
      </DocsBody>
    </DocsPage>
  )
}

export async function generateStaticParams() {
  return source.generateParams()
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { lang, slug } = await params
  const page = source.getPage(slug, lang)
  if (!page) notFound()

  return {
    title: page.data.title,
    description: page.data.description,
  }
}
