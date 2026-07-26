/** @jest-environment jsdom */

import { render, screen } from "@testing-library/react"
import { NotFoundContent } from "./not-found-content"

let activeLocale = "en"

jest.mock("next-intl", () => ({
  NextIntlClientProvider: ({ locale, children }: { locale: string; children: React.ReactNode }) => {
    activeLocale = locale
    return <>{children}</>
  },
  useTranslations: () => (key: string) => {
    const messages: Record<string, Record<string, string>> = {
      en: {
        heading: "Page not found",
        body: "The page this link points to has moved or no longer exists.",
        docs: "Back to the docs home",
        other: "中文版本",
      },
      "zh-CN": {
        heading: "页面不存在",
        body: "这个链接指向的页面已被移动或删除。",
        docs: "返回文档首页",
        other: "English version",
      },
    }
    return messages[activeLocale]?.[key] ?? key
  },
}))

const messages = {
  en: { docsSite: {} },
  zh: { docsSite: {} },
}

describe("NotFoundContent", () => {
  it("renders localized copy through next-intl", () => {
    render(<NotFoundContent languages={["zh", "en"]} defaultLanguage="zh" messages={messages} />)

    expect(screen.getByRole("heading", { name: "页面不存在" })).toBeInTheDocument()
    expect(screen.getByRole("link", { name: "返回文档首页" })).toHaveAttribute("href", "/zh/docs")
  })
})
