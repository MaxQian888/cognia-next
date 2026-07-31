import { notFound } from "next/navigation"
import type { Metadata } from "next"
import { DocsPage, DocsBody, DocsTitle, DocsDescription } from "fumadocs-ui/page"
import { source } from "@/lib/source"
import { getMDXComponents } from "@/components/mdx-components"
import { PageFooter } from "@/components/page-footer"
import { PageActions } from "@/components/page-actions"
import { markdownHref } from "@/lib/llms-format"
import { docsSourcePath, getDocsLastModified } from "@/lib/last-modified"
import { metadataAlternates } from "@/lib/alternates"
import { SITE_NAME, absoluteUrl } from "@/lib/site"

type Props = {
  params: Promise<{ lang: string; slug?: string[] }>
}

export default async function Page({ params }: Props) {
  const { lang, slug } = await params
  const page = source.getPage(slug, lang)
  if (!page) notFound()

  const MDX = page.data.body
  const footerSlug = [lang, ...(slug ?? [])]
  const sourcePath = docsSourcePath(page.path)
  const lastModified = getDocsLastModified(page.path)

  return (
    <DocsPage toc={page.data.toc} full={page.data.full}>
      <DocsTitle>{page.data.title}</DocsTitle>
      <DocsDescription>{page.data.description}</DocsDescription>
      <DocsBody>
        <PageActions markdownHref={markdownHref(lang, page.slugs)} />
        <MDX components={getMDXComponents()} />
        <PageFooter slug={footerSlug} sourcePath={sourcePath} lastModified={lastModified} />
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

  const { title, description } = page.data
  const canonical = absoluteUrl(page.url)

  return {
    title,
    description,
    alternates: metadataAlternates(canonical, slug),
    openGraph: {
      type: "article",
      siteName: SITE_NAME,
      locale: lang,
      title,
      description,
      url: canonical,
    },
    twitter: { card: "summary_large_image", title, description },
  }
}
