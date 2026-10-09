import { ISSUES_HREF, ISSUE_SOURCE_PARAM, agentIssuesHref, issueHref } from "./hrefs"

describe("issueHref", () => {
  it("selects the issue through the query param the page reads", () => {
    expect(issueHref("iss-1")).toBe("/issues?id=iss-1")
  })

  it("encodes the id rather than trusting it", () => {
    expect(issueHref("a b/c")).toBe(`${ISSUES_HREF}?id=a%20b%2Fc`)
  })

  it("names a non-local source, because ids alone are ambiguous across sources", () => {
    expect(issueHref("iss_1", "collab")).toBe(`/issues?id=iss_1&${ISSUE_SOURCE_PARAM}=collab`)
    expect(issueHref("iss_1", "local")).toBe("/issues?id=iss_1")
  })
})

describe("agentIssuesHref", () => {
  it("filters the console to the agent's actorKey", () => {
    expect(agentIssuesHref("char_1")).toBe(`${ISSUES_HREF}?assignee=agent%3Achar_1`)
    expect(new URLSearchParams(agentIssuesHref("a b").split("?")[1]).get("assignee")).toBe(
      "agent:a b"
    )
  })
})
