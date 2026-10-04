import { describe, expect, it } from "vitest"

import { escapeHtml, htmlResponse, jsonForScript, newNonce, renderDocument } from "./document"

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
})
