import { ISSUES_HREF, issueHref } from "./hrefs"

describe("issueHref", () => {
  it("selects the issue through the query param the page reads", () => {
    expect(issueHref("iss-1")).toBe("/issues?id=iss-1")
  })

  it("encodes the id rather than trusting it", () => {
    expect(issueHref("a b/c")).toBe(`${ISSUES_HREF}?id=a%20b%2Fc`)
  })
})
