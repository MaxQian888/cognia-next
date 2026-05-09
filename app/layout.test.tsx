jest.mock("next/font/google", () => ({
  Geist: () => ({ variable: "--font-geist-sans" }),
  Geist_Mono: () => ({ variable: "--font-geist-mono" }),
}))

jest.mock("next-intl/server", () => ({
  getLocale: jest.fn(async () => "en"),
}))

// matchMedia isn't implemented by jsdom — next-themes reads it during SSR.
if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: jest.fn(),
      removeListener: jest.fn(),
      addEventListener: jest.fn(),
      removeEventListener: jest.fn(),
      dispatchEvent: jest.fn(),
    }),
  })
}

import { renderToStaticMarkup } from "react-dom/server"
import RootLayout, { metadata } from "./layout"

describe("RootLayout", () => {
  it("exports metadata used by Next.js", () => {
    expect(metadata).toMatchObject({
      title: "Cognia · Claude Code",
      description: "Claude Code web client built on top of the Claude Agent SDK",
    })
  })

  it("renders html/body with font variables and children", async () => {
    const tree = await RootLayout({ children: <main>content</main> })
    const markup = renderToStaticMarkup(tree)

    expect(markup).toContain('<html lang="en"')
    expect(markup).toContain("--font-geist-sans")
    expect(markup).toContain("--font-geist-mono")
    expect(markup).toContain("antialiased")
    expect(markup).toContain("<main>content</main>")
  })

  it("uses the locale resolved by next-intl getLocale", async () => {
    const { getLocale } = jest.requireMock("next-intl/server") as {
      getLocale: jest.Mock<Promise<string>, []>
    }
    getLocale.mockResolvedValueOnce("zh-CN")
    const tree = await RootLayout({ children: <main>x</main> })
    const markup = renderToStaticMarkup(tree)
    expect(markup).toContain('<html lang="zh-CN"')
  })
})
