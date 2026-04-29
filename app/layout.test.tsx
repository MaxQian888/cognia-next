jest.mock("next/font/google", () => ({
  Geist: () => ({ variable: "--font-geist-sans" }),
  Geist_Mono: () => ({ variable: "--font-geist-mono" }),
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

  it("renders html/body with font variables and children", () => {
    const markup = renderToStaticMarkup(
      <RootLayout>
        <main>content</main>
      </RootLayout>
    )

    expect(markup).toContain('<html lang="en"')
    expect(markup).toContain("--font-geist-sans")
    expect(markup).toContain("--font-geist-mono")
    expect(markup).toContain("antialiased")
    expect(markup).toContain("<main>content</main>")
  })
})
