import {
  CHANGELOG_URL,
  COMMUNITY_URL,
  DOCS_COMPANION_SETUP_URL,
  DOCS_URL,
  GITHUB_URL,
  ISSUES_URL,
  LICENSE_URL,
  PRIVACY_URL,
  RELEASES_URL,
} from "./external-urls"

describe("external-urls", () => {
  it("points the repo at the real source (not anthropics/claude-code)", () => {
    expect(GITHUB_URL).toBe("https://github.com/MaxQian888/cognia-next")
  })

  it("derives sub-URLs from the repo root", () => {
    expect(ISSUES_URL).toBe(`${GITHUB_URL}/issues`)
    expect(RELEASES_URL).toBe(`${GITHUB_URL}/releases`)
    expect(CHANGELOG_URL).toBe(RELEASES_URL)
    expect(LICENSE_URL.startsWith(`${GITHUB_URL}/blob/`)).toBe(true)
    expect(COMMUNITY_URL).toBe(`${GITHUB_URL}/discussions`)
  })

  it("derives docs-hosted URLs from the docs root", () => {
    expect(PRIVACY_URL.startsWith(DOCS_URL)).toBe(true)
    expect(DOCS_COMPANION_SETUP_URL.startsWith(DOCS_URL)).toBe(true)
  })

  it("uses absolute https URLs everywhere", () => {
    for (const url of [
      DOCS_URL,
      GITHUB_URL,
      ISSUES_URL,
      RELEASES_URL,
      CHANGELOG_URL,
      LICENSE_URL,
      COMMUNITY_URL,
      PRIVACY_URL,
      DOCS_COMPANION_SETUP_URL,
    ]) {
      expect(url).toMatch(/^https:\/\//)
    }
  })
})
