/**
 * @jest-environment jsdom
 */

import { escapeHtml, renderHTML, renderSVG, getReactShellHtml, sanitizeHTML } from "./preview-utils"

describe("escapeHtml", () => {
  it("escapes the canonical HTML special characters", () => {
    expect(escapeHtml(`<a href="x">'a'&'b'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&#039;a&#039;&amp;&#039;b&#039;&lt;/a&gt;"
    )
  })

  it("returns empty string unchanged", () => {
    expect(escapeHtml("")).toBe("")
  })
})

describe("renderHTML / renderSVG", () => {
  function newDocument(): Document {
    const iframe = document.createElement("iframe")
    document.body.appendChild(iframe)
    const doc = iframe.contentDocument!
    return doc
  }

  it("writes sanitized HTML into the document", () => {
    const doc = newDocument()
    renderHTML(doc, "<html><body><p>hi</p></body></html>")
    expect(doc.body.innerHTML.toLowerCase()).toContain("<p>hi</p>")
  })

  it("strips script tags during sanitization", () => {
    const doc = newDocument()
    renderHTML(doc, "<html><body><script>alert(1)</script><p>safe</p></body></html>")
    expect(doc.body.innerHTML).not.toMatch(/<script/i)
    expect(doc.body.innerHTML.toLowerCase()).toContain("<p>safe</p>")
  })

  it("sanitizes reusable HTML while preserving safe document content", () => {
    const sanitized = sanitizeHTML(
      '<meta http-equiv="refresh" content="0;url=https://evil.example"><table><tbody><tr><td>safe</td></tr></tbody></table><img src="data:image/png;base64,AA==" onerror="alert(1)"><form action="https://evil.example"><input></form><script>alert(1)</script>'
    )

    expect(sanitized).toContain("<table")
    expect(sanitized).toContain("safe")
    expect(sanitized).toContain("data:image/png")
    expect(sanitized).not.toMatch(/http-equiv|onerror|<form|<input|<script/i)
  })

  it("can sanitize a fragment without wrapping it as a document", () => {
    expect(sanitizeHTML("<strong>safe</strong>", { wholeDocument: false })).toBe(
      "<strong>safe</strong>"
    )
  })

  it("renders SVG inside a wrapper page", () => {
    const doc = newDocument()
    renderSVG(doc, '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>')
    expect(doc.body.innerHTML.toLowerCase()).toContain("<svg")
    expect(doc.body.innerHTML.toLowerCase()).toContain("<rect")
  })
})

describe("getReactShellHtml", () => {
  const messages = {
    cdnLoadTitle: "CDN Loading Failed",
    cdnLoadDescription:
      "Unable to load React dependencies from CDN. Check your network connection.",
    noComponentFound: "No component found. Export an App, Component, or Main function.",
  }
  const html = getReactShellHtml(messages)

  it("includes a CSP meta tag locking external dependencies to known CDNs", () => {
    expect(html).toMatch(/Content-Security-Policy/i)
    expect(html).toMatch(/unpkg\.com/)
    expect(html).toMatch(/cdn\.tailwindcss\.com/)
  })

  it("loads React 19 + ReactDOM + Babel standalone via CDN", () => {
    expect(html).toMatch(/react@19/)
    expect(html).toMatch(/react-dom@19/)
    expect(html).toMatch(/@babel\/standalone/)
  })

  it("listens for postMessage 'render-component' to inject code", () => {
    expect(html).toMatch(/render-component/)
    expect(html).toMatch(/createRoot/)
  })

  it("injects the provided messages into the iframe shell", () => {
    expect(html).toMatch(/CDN Loading Failed/)
    expect(html).toContain(messages.cdnLoadDescription)
    expect(html).toContain(messages.noComponentFound)
  })

  it("renders translated messages when given non-English values", () => {
    const localized = getReactShellHtml({
      cdnLoadTitle: "CDN 加载失败",
      cdnLoadDescription: "无法从 CDN 加载 React 依赖，请检查网络连接。",
      noComponentFound: "未找到组件。",
    })
    expect(localized).toContain("CDN 加载失败")
    expect(localized).toContain("无法从 CDN 加载 React 依赖")
    expect(localized).toContain("未找到组件。")
  })

  it("safely escapes characters that would otherwise break the inline script", () => {
    const tricky = getReactShellHtml({
      cdnLoadTitle: 'has "quotes" and \\backslash',
      cdnLoadDescription: "ends with </script>tag",
      noComponentFound: "newline\nthen 'apostrophe'",
    })
    // The </script> sequence must be broken so the inline script doesn't end early.
    expect(tricky).not.toMatch(/<\/script>tag/)
    // The original characters survive in some encoded form (JSON.stringify escapes them).
    expect(tricky).toContain('has \\"quotes\\"')
    expect(tricky).toContain("\\\\backslash")
  })
})
