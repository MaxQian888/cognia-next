import { defineI18nUI } from "fumadocs-ui/i18n"
import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared"
import { i18n } from "@/lib/i18n"
// Relative rather than `@/`: this module has tests, and the repo's Jest runner
// maps that alias to the app root rather than to `docs/`.
import { BrandMark } from "../components/brand-mark"
import { REPO_URL, SITE_NAME } from "./site"

export const i18nUI = defineI18nUI(i18n, {
  zh: {
    displayName: "中文",
    search: "搜索文档",
    searchNoResult: "无结果",
    toc: "本页内容",
    tocNoHeadings: "无标题",
    lastUpdate: "最后更新于",
    chooseLanguage: "选择语言",
    chooseTheme: "主题",
    editOnGithub: "在 GitHub 上编辑",
    nextPage: "下一页",
    previousPage: "上一页",
  },
  en: {
    displayName: "English",
    search: "Search docs",
  },
})

// The shared base, not `DocsLayoutProps`: both the docs layout and the landing
// page's `HomeLayout` take these, and their slot types differ.
export function baseOptions(lang: string): BaseLayoutProps {
  return {
    nav: {
      // The website's lockup: the mark, then the name in mono.
      title: (
        <span className="inline-flex items-center gap-2 font-mono text-sm tracking-tight">
          <BrandMark />
          {SITE_NAME}
        </span>
      ),
      // hideLocale is "never" (D8 static export) — every locale is prefixed.
      // The landing page is the home, as on the website.
      url: `/${lang}`,
    },
    githubUrl: REPO_URL,
  }
}
