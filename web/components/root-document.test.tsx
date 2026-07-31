import { renderToStaticMarkup } from "react-dom/server"
import { RootDocument } from "./root-document"

jest.mock("geist/font/sans", () => ({ GeistSans: { variable: "--font-geist-sans-var" } }))
jest.mock("geist/font/mono", () => ({ GeistMono: { variable: "--font-geist-mono-var" } }))
jest.mock("./theme-provider", () => ({
  ThemeProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="theme-provider">{children}</div>
  ),
}))

/**
 * A document shell cannot be mounted inside jsdom's existing document — the
 * parser drops a nested `<html>` — so it is asserted as the markup the static
 * export actually emits.
 */
function markup(locale: "en" | "zh"): string {
  return renderToStaticMarkup(
    <RootDocument locale={locale}>
      <span>page</span>
    </RootDocument>
  )
}

describe("RootDocument", () => {
  it("declares the English document language", () => {
    expect(markup("en")).toContain('<html lang="en"')
  })

  it("declares the Chinese document language as a BCP-47 tag", () => {
    expect(markup("zh")).toContain('<html lang="zh-Hans"')
  })

  it("exposes both font variables on the body", () => {
    const html = markup("en")
    expect(html).toContain("--font-geist-sans-var")
    expect(html).toContain("--font-geist-mono-var")
  })

  it("mounts the theme provider around the page", () => {
    const html = markup("en")
    expect(html).toContain('data-testid="theme-provider"')
    expect(html).toContain("<span>page</span>")
  })

  it("emits one html and one body element", () => {
    const html = markup("en")
    expect(html.match(/<html/g)).toHaveLength(1)
    expect(html.match(/<body/g)).toHaveLength(1)
  })
})
