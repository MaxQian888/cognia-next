import { ISSUES_URL } from "@/lib/constants/external-urls"

import {
  MAX_ISSUE_BODY,
  buildIssueUrl,
  resolveIssueTrackerUrl,
  resolveNewIssueEndpoint,
} from "./issue-url"

describe("resolveIssueTrackerUrl", () => {
  it("prefers a non-empty deploy-time override", () => {
    expect(resolveIssueTrackerUrl("https://github.com/acme/app")).toBe(
      "https://github.com/acme/app"
    )
    expect(resolveIssueTrackerUrl("  https://github.com/acme/app  ")).toBe(
      "https://github.com/acme/app"
    )
  })

  it("falls back to the public repository when unset or blank", () => {
    expect(resolveIssueTrackerUrl(undefined)).toBe(ISSUES_URL)
    expect(resolveIssueTrackerUrl("   ")).toBe(ISSUES_URL)
  })
})

describe("resolveNewIssueEndpoint", () => {
  it("normalises a repo root, an /issues listing, and an explicit endpoint", () => {
    expect(resolveNewIssueEndpoint("https://github.com/a/b/")).toBe(
      "https://github.com/a/b/issues/new"
    )
    expect(resolveNewIssueEndpoint(ISSUES_URL)).toBe(`${ISSUES_URL}/new`)
    expect(resolveNewIssueEndpoint("https://github.com/a/b/issues/new//")).toBe(
      "https://github.com/a/b/issues/new"
    )
  })
})

describe("buildIssueUrl", () => {
  it("appends /issues/new when the base is a repo root", () => {
    expect(buildIssueUrl("https://github.com/a/b", "t", "body")).toMatch(
      /^https:\/\/github\.com\/a\/b\/issues\/new\?/
    )
  })

  it("appends /new when the base is the /issues listing", () => {
    const url = buildIssueUrl(ISSUES_URL, "t", "body")
    expect(url).toMatch(/\/issues\/new\?/)
    expect(url).not.toContain("/issues/issues/")
  })

  it("keeps an existing /issues/new endpoint and strips trailing slashes", () => {
    expect(buildIssueUrl("https://github.com/a/b/issues/new/", "t", "x")).toMatch(
      /\/a\/b\/issues\/new\?/
    )
  })

  it("truncates an oversized body", () => {
    const url = buildIssueUrl("https://x.test/r", "t", "Z".repeat(MAX_ISSUE_BODY + 4000))
    const body = new URL(url).searchParams.get("body") ?? ""
    expect(body.length).toBeLessThan(MAX_ISSUE_BODY + 4000)
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
