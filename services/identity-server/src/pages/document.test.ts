import { describe, expect, it } from "vitest"

import { escapeHtml, htmlResponse, jsonForScript, newNonce, renderDocument } from "./document"
import { mascotSvg } from "./mascot"

describe("page document", () => {
  it("escapes HTML and keeps JSON from closing its script tag", () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;"
    )
    const json = jsonForScript({ value: "</script><script>alert(1)</script>\u2028" })
    expect(json).not.toContain("</script>")
    expect(json).not.toContain("\u2028")
    expect(JSON.parse(json)).toEqual({ value: "</script><script>alert(1)</script>\u2028" })
  })

  it("stamps the nonce on the inline style and script only", () => {
    const nonce = newNonce()
    const html = renderDocument({
      locale: "zh",
      title: "<T>",
      nonce,
      mascot: "welcome",
      body: "<p>x</p>",
      data: { a: 1 },
      script: "run()",
    })
    expect(html).toContain('<html lang="zh-CN">')
    expect(html).toContain("<title>&lt;T&gt;</title>")
    expect(html).toContain(`<style nonce="${nonce}">`)
    expect(html).toContain(`<script nonce="${nonce}">run()</script>`)
    expect(html).toContain('<script id="page-data" type="application/json">{"a":1}</script>')
  })

  it("sends a strict CSP bound to the nonce and never caches", () => {
    const response = htmlResponse("<p></p>", "abc", 400)
    expect(response.status).toBe(400)
    const csp = response.headers.get("content-security-policy")!
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain("script-src 'nonce-abc'")
    expect(csp).toContain("frame-ancestors 'none'")
    expect(response.headers.get("cache-control")).toBe("no-store")
    expect(response.headers.get("x-frame-options")).toBe("DENY")
  })

  it("draws fresh nonces", () => {
    expect(newNonce()).not.toBe(newNonce())
  })

  it("carries the Cognia mark and the mascot's expression on every page", async () => {
    const failed = renderDocument({
      locale: "zh",
      title: "t",
      nonce: "n",
      body: "<h1>t</h1>",
      mascot: "worried",
    })
    expect(failed).toContain('class="brand"')
    expect(failed).toContain("<span>Cognia</span><small>账号</small>")
    expect(failed).toContain('data-mascot="worried"')
    expect(failed).toContain(mascotSvg("worried"))
    // The mark and the mascot sit before the page's own heading.
    expect(failed.indexOf('class="brand"')).toBeLessThan(failed.indexOf("<h1>"))
    expect(failed.indexOf('class="hero"')).toBeLessThan(failed.indexOf("<h1>"))
    expect(failed).not.toContain('class="showcase"')
  })

  it("adds the wide-screen showcase only when asked, with its text escaped", () => {
    const html = renderDocument({
      locale: "en",
      title: "t",
      nonce: "n",
      body: "<h1>t</h1>",
      mascot: "welcome",
      showcase: { heading: "<Agents>", text: "a & b" },
    })
    expect(html).toContain('class="stage split"')
    expect(html).toContain("<h2>&lt;Agents&gt;</h2><p>a &amp; b</p>")
    // Narrow screens still get the card's own hero.
    expect(html.match(/<svg xmlns/g)).toHaveLength(2)
  })

  it("styles nothing outside the nonce'd style element", () => {
    const html = renderDocument({ locale: "en", title: "t", nonce: "n", body: "", mascot: "happy" })
    expect(html).not.toMatch(/\sstyle="/)
    expect(html.match(/<style/g)).toHaveLength(1)
  })
})
