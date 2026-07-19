// Geist ships as a self-hosted local font package; its font/* entrypoints call
// next/font/local, which only works under the Next.js compiler. Stub them so the
// layout renders under Jest with the same CSS variables production emits.
jest.mock("geist/font/sans", () => ({
  GeistSans: { variable: "--font-geist-sans" },
}))
jest.mock("geist/font/mono", () => ({
  GeistMono: { variable: "--font-geist-mono" },
}))

jest.mock("next-intl/server", () => ({
  getLocale: jest.fn(async () => "en"),
}))

// DesktopAppShell pulls in the desktop chrome + command palette, which
// transitively imports `use-stick-to-bottom` (an ESM-only module Jest can't
// transform without extra config). For this layout test we only care that
// children render inside the providers, so a passthrough stub is enough.
jest.mock("@/components/desktop/desktop-app-shell", () => ({
  DesktopAppShell: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

jest.mock("@/components/account/account-gate", () => ({
  AccountGate: ({ children }: { children: React.ReactNode }) => <>{children}</>,
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
