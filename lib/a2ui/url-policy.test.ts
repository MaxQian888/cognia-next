import {
  a2uiActionTarget,
  isWebHref,
  safeA2UIHref,
  safeA2UIMediaSrc,
  safeA2UIStyle,
} from "./url-policy"
import { untrustedMarkdownUrlTransform } from "@/components/chat/markdown/rendering-policy"

const HREFS = [
  "https://example.com/a?b=1",
  "HTTP://example.com",
  "  https://example.com  ",
  "mailto:someone@example.com",
  "javascript:alert(1)",
  "JavaScript:alert(1)",
  "java\tscript:alert(1)",
  " javascript:alert(1)",
  "vbscript:msgbox(1)",
  "data:text/html,<script>alert(1)</script>",
  "file:///etc/passwd",
  "tel:+123",
  "cognia://settings",
  "/settings",
  "//evil.example",
  "#anchor",
  "",
]

describe("safeA2UIHref", () => {
  it("allows web and mail links only", () => {
    expect(safeA2UIHref("https://example.com/a?b=1")).toBe("https://example.com/a?b=1")
    expect(safeA2UIHref("  https://example.com  ")).toBe("https://example.com/")
    expect(safeA2UIHref("mailto:someone@example.com")).toBe("mailto:someone@example.com")
    for (const url of HREFS.slice(4)) expect(safeA2UIHref(url)).toBeNull()
  })

  it.each([
    "https:evil.com",
    "\x01https://evil.com",
    "https:\\\\evil.com",
    "ht\ttps://evil.com",
    "http:/evil.com",
    "HTTPS://EVIL.com",
  ])("returns %j in the canonical form ExternalLink recognises", (url) => {
    const href = safeA2UIHref(url)
    expect(href).toMatch(/^https?:\/\/evil\.com\/$/)
  })

  it("rejects non-strings and unparsable web URLs", () => {
    expect(safeA2UIHref(undefined)).toBeNull()
    expect(safeA2UIHref({ path: "/x" })).toBeNull()
    expect(safeA2UIHref("https://")).toBeNull()
  })

  it("accepts and rejects exactly what the untrusted chat Markdown policy does", () => {
    for (const url of HREFS) {
      expect([url, safeA2UIHref(url) !== null]).toEqual([
        url,
        untrustedMarkdownUrlTransform(url.trim(), "href") !== "",
      ])
    }
  })
})

describe("a2uiActionTarget", () => {
  it.each<[unknown, string | null]>([
    ["https://example.com/a", "https://example.com/a"],
    ["mailto:a@example.com", "mailto:a@example.com"],
    ["/settings", "/settings"],
    ["#step-2", "#step-2"],
    ["next", "next"],
    ["javascript:alert(1)", null],
    ["java\tscript:alert(1)", null],
    ["file:///etc/passwd", null],
    ["  ", null],
    [42, null],
  ])("%p → %p", (value, expected) => {
    expect(a2uiActionTarget(value)).toBe(expected)
  })
})

describe("isWebHref", () => {
  it("tells web pages from mail links", () => {
    expect(isWebHref("https://example.com")).toBe(true)
    expect(isWebHref("mailto:a@b.c")).toBe(false)
  })
})

describe("safeA2UIMediaSrc", () => {
  it.each([
    ["https://example.com/a.png", true],
    ["data:image/png;base64,AAAA", true],
    ["blob:https://app/uuid", true],
    ["/icons/logo.png", true],
    ["//evil.example/a.png", false],
    ["/\\evil.example/a.png", false],
    ["data:text/html,<b>x</b>", false],
    ["javascript:alert(1)", false],
    ["file:///tmp/a.png", false],
    ["", false],
  ])("%s → %s", (src, allowed) => {
    expect(safeA2UIMediaSrc(src) !== null).toBe(allowed)
  })

  it("agrees with the untrusted chat policy for web and data images", () => {
    for (const src of ["https://example.com/a.png", "data:image/png;base64,AA", "javascript:x"]) {
      expect(safeA2UIMediaSrc(src) !== null).toBe(untrustedMarkdownUrlTransform(src, "src") !== "")
    }
  })
})

describe("safeA2UIStyle", () => {
  it("keeps ordinary properties and web or data images", () => {
    const style = {
      color: "red",
      padding: 8,
      backgroundImage: 'url("https://example.com/a.png"), url(data:image/png;base64,AAAA)',
      background: "linear-gradient(red, blue)",
    }
    expect(safeA2UIStyle(style)).toEqual(style)
  })

  it.each([
    ["a file URL", { backgroundImage: "url(file:///etc/passwd)" }],
    ["a script URL", { background: "url('javascript:alert(1)')" }],
    ["a custom scheme", { cursor: "url(cognia://x), auto" }],
    ["an unclosed url()", { backgroundImage: "url(file:///etc/passwd" }],
    ["a protocol-relative URL", { maskImage: "url(//evil.example/x.svg)" }],
    ["image-set strings", { backgroundImage: 'image-set("file:///x" 1x)' }],
    ["a CSS escape", { backgroundImage: "\\75 rl(file:///x)" }],
    ["expression()", { width: "expression(alert(1))" }],
    ["a script-bearing property", { behavior: "url(x.htc)" }],
  ])("drops %s and keeps the rest", (_name, unsafe) => {
    expect(safeA2UIStyle({ color: "red", ...unsafe })).toEqual({ color: "red" })
  })

  it("drops values that are not CSS strings or finite numbers", () => {
    expect(safeA2UIStyle({ color: "red", width: Number.NaN, nested: { a: 1 } })).toEqual({
      color: "red",
    })
  })

  it("is undefined for anything that is not a style object", () => {
    expect(safeA2UIStyle(undefined)).toBeUndefined()
    expect(safeA2UIStyle("color: red")).toBeUndefined()
    expect(safeA2UIStyle(["x"])).toBeUndefined()
  })
})
