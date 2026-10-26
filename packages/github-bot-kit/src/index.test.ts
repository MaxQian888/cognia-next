import * as kit from "./index"

it("exports the kit's public surface from one entry", () => {
  for (const name of [
    "checkCommandAuthor",
    "currentCiExecutions",
    "parseCommand",
    "selectContext",
    "maskMarkdown",
    "renderBotComment",
    "githubReader",
    "GithubRequestError",
    "parseRepository",
    "groupReviewThreads",
    "publishGithubReview",
    "sanitizeControlChars",
  ]) {
    expect(kit).toHaveProperty(name)
  }
  // Test doubles stay on their own subpath, out of plugin bundles.
  expect(kit).not.toHaveProperty("memoizedStep")
})
