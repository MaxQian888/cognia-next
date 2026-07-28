import { buildErrorReportMarkdown, buildIssueUrl, type ErrorReportContext } from "./build-report"
import type { StructuredLogEntry } from "@/types/logging"

const context: ErrorReportContext = { category: "render", locale: "en", pathname: "/x" }

describe("buildIssueUrl", () => {
  it("appends /issues/new when the base is a repo root", () => {
    expect(buildIssueUrl("https://github.com/a/b", "t", "body")).toMatch(
      /^https:\/\/github\.com\/a\/b\/issues\/new\?/
    )
  })

  it("keeps an existing /issues/new endpoint and strips trailing slashes", () => {
    expect(buildIssueUrl("https://github.com/a/b/issues/new/", "t", "x")).toMatch(
      /\/a\/b\/issues\/new\?/
    )
  })

  it("truncates an oversized body", () => {
    // Trackers reject very long query strings, and an untruncated stack fails
    // silently rather than loudly.
    const url = buildIssueUrl("https://x.test/r", "t", "Z".repeat(10000))
    const body = new URL(url).searchParams.get("body") ?? ""
    expect(body.length).toBeLessThan(10000)
    expect(body.endsWith("…")).toBe(true)
  })

  it("percent-encodes the title and body", () => {
    const url = buildIssueUrl("https://x.test/r", "a b&c", "d=e")
    expect(url).not.toContain("a b&c")
    const parsed = new URL(url)
    expect(parsed.searchParams.get("title")).toBe("a b&c")
    expect(parsed.searchParams.get("body")).toBe("d=e")
  })
})

describe("buildErrorReportMarkdown", () => {
  const recent: StructuredLogEntry[] = [
    {
      id: "r1",
      timestamp: "2026-06-23T10:00:00.000Z",
      level: "error",
      message: "earlier",
      module: "app",
    } as StructuredLogEntry,
  ]

  it("includes error, diagnostics, and recent sections", () => {
    const md = buildErrorReportMarkdown({
      error: Object.assign(new Error("boom"), { digest: "abc", stack: "stack-trace" }),
      context,
      recent,
      diagnostics: { isTauri: false, appVersion: "1.0.0" },
      generatedAt: "2026-06-23T10:00:01.000Z",
    })
    expect(md).toContain("Error ID: abc")
    expect(md).toContain("boom")
    expect(md).toContain("stack-trace")
    expect(md).toContain("appVersion")
    expect(md).toContain("Recent errors (1)")
    expect(md).toContain("earlier")
  })

  it("degrades gracefully with no error and no diagnostics", () => {
    const md = buildErrorReportMarkdown({
      error: null,
      context,
      recent: [],
      diagnostics: null,
      generatedAt: "2026-06-23T10:00:01.000Z",
    })
    expect(md).toContain("No error object was provided")
    expect(md).toContain("Diagnostics unavailable")
    expect(md).toContain("Recent errors (0)")
    expect(md).toContain("None recorded")
  })

  it("omits the error-id line when there is no digest", () => {
    const md = buildErrorReportMarkdown({
      error: new Error("boom"),
      context,
      recent: [],
      diagnostics: null,
      generatedAt: "2026-06-23T10:00:01.000Z",
    })
    expect(md).not.toContain("Error ID:")
  })

  it("renders an em dash for a null route rather than the string 'null'", () => {
    const md = buildErrorReportMarkdown({
      error: null,
      context: { ...context, pathname: null },
      recent: [],
      diagnostics: null,
      generatedAt: "2026-06-23T10:00:01.000Z",
    })
    expect(md).toContain("- Route: —")
  })

  it("keeps the error block when the throw carried no stack", () => {
    const err = new Error("boom")
    delete err.stack
    const md = buildErrorReportMarkdown({
      error: err,
      context,
      recent: [],
      diagnostics: null,
      generatedAt: "2026-06-23T10:00:01.000Z",
    })
    expect(md).toContain("Error: boom")
  })
})
