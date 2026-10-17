import type { Metadata } from "next"
import { HomeLayout } from "fumadocs-ui/layouts/home"
import { HomePage } from "@/components/home-page"
import { baseOptions } from "@/lib/layout.shared"
import { findTopLevelPage, homeGroups, type TreeNode } from "@/lib/home-sections"
import { source } from "@/lib/source"
import { REPO_URL, SITE_NAME, absoluteUrl, websiteUrl } from "@/lib/site"
import enMessages from "../../../i18n/messages/en.json"
import zhMessages from "../../../i18n/messages/zh-CN.json"

type Props = { params: Promise<{ lang: string }> }

function homeCopy(lang: string) {
  return (lang === "en" ? enMessages : zhMessages).docsSite.home
}

/**
 * The docs landing page. It used to redirect straight into `/docs`, which left
 * the site without a front door: arriving from the website dropped readers on
 * the first article with no sense of what the docs cover.
 */
export default async function Home({ params }: Props) {
  const { lang } = await params
  const tree = source.getPageTree(lang).children as unknown as TreeNode[]
  const overviewHref = `/${lang}/docs`

  return (
    <HomeLayout
      {...baseOptions(lang)}
      links={[{ text: homeCopy(lang).navDocs, url: overviewHref, active: "nested-url" }]}
    >
      <HomePage
        lang={lang}
        groups={homeGroups(tree)}
        gettingStartedHref={findTopLevelPage(tree, "getting-started") ?? overviewHref}
        overviewHref={overviewHref}
        repoUrl={REPO_URL}
        websiteUrl={websiteUrl()}
      />
    </HomeLayout>
  )
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { lang } = await params
  const copy = homeCopy(lang)
  const canonical = absoluteUrl(`/${lang}`)

  return {
    title: { absolute: `${SITE_NAME} — ${copy.eyebrow}` },
    description: copy.subtitle,
    alternates: {
      canonical,
      languages: {
        en: absoluteUrl("/en"),
        zh: absoluteUrl("/zh"),
        "x-default": absoluteUrl("/zh"),
      },
    },
    openGraph: {
      type: "website",
      siteName: SITE_NAME,
      locale: lang,
      title: copy.title,
      description: copy.subtitle,
      url: canonical,
    },
  }
}
