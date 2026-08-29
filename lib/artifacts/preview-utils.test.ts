/**
 * @jest-environment jsdom
 */

import {
  applyArtifactThemeVariables,
  escapeHtml,
  renderHTML,
  renderSVG,
  buildArtifactFrameCsp,
  getInteractiveHtmlShellHtml,
  getReactShellHtml,
  sanitizeHTML,
} from "./preview-utils"

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

  it("removes network-capable resources for the diagram renderer profile", () => {
    const sanitized = sanitizeHTML(
      `<!doctype html><html><head>
        <link rel="stylesheet" href="https://cdn.example/theme.css">
        <style>
          @import url("https://cdn.example/import.css");
          .remote { background-image: url(https://cdn.example/paper.png); }
          .marker { marker-end: url(#arrow); }
          .embedded { background-image: url(data:image/png;base64,AA==); }
        </style>
      </head><body>
        <img id="remote" src="https://cdn.example/image.png">
        <img id="embedded" src="data:image/png;base64,AA==">
        <a id="remote-link" href="https://example.com">remote</a>
        <svg><defs><filter id="shadow"><feGaussianBlur stdDeviation="2" /></filter></defs>
          <path marker-end="url(#arrow)" filter="url(#shadow)" />
        </svg>
      </body></html>`,
      { rendererProfile: "diagram-design-v1" }
    )

    expect(sanitized).not.toMatch(/<link|@import|https:\/\/cdn\.example|href="https:/i)
    expect(sanitized).toContain("url(#arrow)")
    expect(sanitized).toContain("url(#shadow)")
    expect(sanitized).toContain("data:image/png;base64,AA==")
    expect(sanitized).toContain("feGaussianBlur")
  })

  it("keeps ordinary HTML resource behavior unchanged", () => {
    const sanitized = sanitizeHTML(
      '<link rel="stylesheet" href="https://cdn.example/theme.css"><img src="https://cdn.example/image.png">'
    )

    expect(sanitized).toContain("<link")
    expect(sanitized).toContain("https://cdn.example/image.png")
  })

  it("applies and updates renderer theme variables without rewriting content", () => {
    const doc = newDocument()
    renderHTML(doc, "<html><body><p>diagram</p></body></html>", {
      rendererProfile: "diagram-design-v1",
      themeVariables: { "--primary": "#3366ff", "--background": "#ffffff" },
    })

    expect(doc.documentElement.style.getPropertyValue("--primary")).toBe("#3366ff")
    expect(doc.body.textContent).toContain("diagram")

    applyArtifactThemeVariables(doc, { "--primary": "#ff3366" })
    expect(doc.documentElement.style.getPropertyValue("--primary")).toBe("#ff3366")
    expect(doc.body.textContent).toContain("diagram")
  })

  it("renders SVG inside a wrapper page", () => {
    const doc = newDocument()
    renderSVG(doc, '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>')
    expect(doc.body.innerHTML.toLowerCase()).toContain("<svg")
    expect(doc.body.innerHTML.toLowerCase()).toContain("<rect")
  })
})

describe("getReactShellHtml", () => {
  const runtime = {
    origin: "tauri://localhost",
    reactRuntimeUrl: "tauri://localhost/artifact-runtime/react-runtime.js",
    shellUrl: "tauri://localhost/artifact-runtime/artifact-shell.js",
  }
  const html = getReactShellHtml(runtime)

  it("carries no external origin at all", () => {
    // React 19 publishes no UMD build, so `unpkg.com/react@19/umd/*` was a hard
    // 404 and every preview fell through to a 15s timeout notice.
    expect(html).not.toMatch(/unpkg\.com/)
    expect(html).not.toMatch(/cdn\.tailwindcss\.com/)
    expect(html).not.toMatch(/https?:\/\//)
  })

  it("loads both bundles from the shell origin", () => {
    expect(html).toContain(`<script src="${runtime.reactRuntimeUrl}"></script>`)
    expect(html).toContain(`<script src="${runtime.shellUrl}"></script>`)
  })

  it("contains no inline script and no eval", () => {
    // A srcdoc child inherits the packaged shell's CSP, which grants neither
    // 'unsafe-inline' nor 'unsafe-eval' — an inline shell simply never runs.
    expect(html).not.toMatch(/<script(?![^>]*\ssrc=)/i)
    expect(html).not.toMatch(/\beval\(/)
    expect(html).not.toMatch(/new Function/)
  })

  it("names the shell origin and blob: in its own policy", () => {
    // The frame policy intersects with the inherited one; naming only
    // 'unsafe-inline' (as the old shell did) makes that intersection empty.
    expect(html).toMatch(/Content-Security-Policy/i)
    expect(html).toContain("script-src tauri://localhost blob:")
    expect(html).toContain("connect-src 'none'")
    expect(html).not.toContain("'unsafe-inline'; script")
  })

  it("mounts a single root container for the bootstrap", () => {
    expect(html).toContain('<div id="root"></div>')
  })
})

describe("buildArtifactFrameCsp", () => {
  it("forbids network access and nested contexts", () => {
    const csp = buildArtifactFrameCsp("https://app.example")
    expect(csp).toContain("default-src 'none'")
    expect(csp).toContain("connect-src 'none'")
    expect(csp).toContain("object-src 'none'")
    expect(csp).toContain("base-uri 'none'")
    expect(csp).toContain("form-action 'none'")
  })

  it("never grants unsafe-inline or unsafe-eval", () => {
    const csp = buildArtifactFrameCsp("https://app.example")
    expect(csp).not.toContain("'unsafe-eval'")
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/)
  })
})

describe("getInteractiveHtmlShellHtml", () => {
  const runtime = {
    origin: "tauri://localhost",
    shellUrl: "tauri://localhost/artifact-runtime/artifact-shell.js",
  }

  it("puts the policy ahead of the bootstrap it governs", () => {
    const html = getInteractiveHtmlShellHtml(
      "<html><head></head><body><p>x</p></body></html>",
      runtime
    )
    expect(html.indexOf("Content-Security-Policy")).toBeLessThan(html.indexOf("artifact-shell.js"))
  })

  it("keeps the artifact's body and adds no inline script", () => {
    const html = getInteractiveHtmlShellHtml(
      "<html><head></head><body><p>x</p></body></html>",
      runtime
    )
    expect(html).toContain("<p>x</p>")
    expect(html).not.toMatch(/<script(?![^>]*\ssrc=)/i)
  })
})
