import { defineI18nUI } from "fumadocs-ui/i18n"
import type { DocsLayoutProps } from "fumadocs-ui/layouts/docs"
import { i18n } from "@/lib/i18n"
import { SITE_NAME } from "./site"

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

export function baseOptions(lang: string): Omit<DocsLayoutProps, "tree" | "children"> {
  return {
    nav: {
      title: SITE_NAME,
      // hideLocale is "never" (D8 static export) — every locale is prefixed.
      url: `/${lang}/docs`,
    },
  }
}
