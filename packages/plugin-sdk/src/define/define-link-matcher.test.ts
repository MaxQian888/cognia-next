import { defineLinkMatcher } from "./define-link-matcher"

describe("defineLinkMatcher", () => {
  it("preserves the declarative URL matcher and its loading metadata", () => {
    const def = {
      id: "pull-request",
      patterns: ["github.com/**/pull/*"],
      entry: "src/links.tsx",
      export: "PullRequestLink",
      label: "Pull request",
      priority: 10,
    }
    expect(defineLinkMatcher(def)).toBe(def)
  })
})
