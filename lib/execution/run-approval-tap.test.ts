import { RUN_APPROVAL_HREFS, runApprovalTapHref } from "./run-approval-tap"

describe("runApprovalTapHref", () => {
  it("opens the page the push names when it is an approvals page", () => {
    expect(runApprovalTapHref({ interruptId: "i", href: "/bots" })).toBe(RUN_APPROVAL_HREFS.bots)
    expect(runApprovalTapHref({ interruptId: "i", href: "/scheduler" })).toBe("/scheduler")
  })

  it("ignores a push that is not a run approval", () => {
    expect(runApprovalTapHref(undefined)).toBeNull()
    expect(runApprovalTapHref({ href: "/bots" })).toBeNull()
    expect(runApprovalTapHref({ interruptId: "", href: "/bots" })).toBeNull()
  })

  it("never follows a deep link outside the approvals pages", () => {
    expect(runApprovalTapHref({ interruptId: "i", href: "/settings" })).toBeNull()
    expect(runApprovalTapHref({ interruptId: "i", href: "//evil.example/bots" })).toBeNull()
    expect(runApprovalTapHref({ interruptId: "i", href: "https://example.com" })).toBeNull()
    expect(runApprovalTapHref({ interruptId: "i" })).toBeNull()
  })
})
